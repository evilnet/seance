/**
 * The dial ledger (irc/dialLedger.ts): nefarious2's connection throttle
 * (IPcheck: the fourth connection in a chain of gaps of 40 s or less is
 * refused, and a refusal renews the window), replayed over this device's own
 * dials so the transport waits instead of dialing into a refusal.
 */

import {expect} from "chai";
import sinon from "sinon";
import type {TransportOptions} from "../../client/js/irc/transport";
import {FakeTransport, register, setup} from "./support";
import {
	NEFARIOUS_RULE,
	dialGateFor,
	parseIpcheckNotice,
	throttleWaitMs,
	useStorageBackend,
	type Sync,
} from "../../client/js/irc/dialLedger";

const S = 1000;

describe("dial ledger (irc/dialLedger.ts)", function () {
	describe("throttleWaitMs", function () {
		it("lets the first dial through", function () {
			expect(throttleWaitMs([], 0, NEFARIOUS_RULE)).to.equal(0);
		});

		it("holds the fourth dial of a quick chain until the gap passes 40 s", function () {
			expect(throttleWaitMs([0, 10 * S, 20 * S], 30 * S, NEFARIOUS_RULE)).to.equal(32 * S);
		});

		it("lets the third dial of a chain through", function () {
			expect(throttleWaitMs([0, 10 * S], 20 * S, NEFARIOUS_RULE)).to.equal(0);
		});

		it("starts over after a gap of more than 40 s", function () {
			// 42 s: a whole second past the 40 s window on any phase, and the 1 s margin.
			expect(throttleWaitMs([0, 10 * S, 20 * S], 62 * S, NEFARIOUS_RULE)).to.equal(0);
		});

		it("counts refused dials, which renew the window", function () {
			expect(
				throttleWaitMs([0, 10 * S, 20 * S, 30 * S, 35 * S], 40 * S, NEFARIOUS_RULE)
			).to.equal(37 * S);
		});

		it("follows the rule's limit", function () {
			const rule = {...NEFARIOUS_RULE, limit: 2};
			expect(throttleWaitMs([0], 10 * S, rule)).to.equal(32 * S);
		});

		it("ignores events dated after now (a clock that ran ahead)", function () {
			const ahead = [3600 * S, 3610 * S, 3620 * S];
			expect(throttleWaitMs(ahead, 0, NEFARIOUS_RULE)).to.equal(0);
		});

		it("waits through the 41st second too, whatever its phase", function () {
			expect(throttleWaitMs([0, 10 * S, 20 * S], 60500, NEFARIOUS_RULE)).to.equal(1500);
			expect(throttleWaitMs([0, 10 * S, 20 * S], 61500, NEFARIOUS_RULE)).to.equal(500);
		});

		it("counts whole seconds, as the server does", function () {
			// 100.2 s and 140.7 s are 40 whole seconds apart on the server: one chain.
			expect(
				throttleWaitMs([100200, 140700, 141000], 142000, NEFARIOUS_RULE)
			).to.be.greaterThan(0);
		});

		it("restarts the gap when a connection closes (IPcheck's reset at the last disconnect)", function () {
			// Thirty seconds in, thirty out, three times: each gap since a close is 30 s.
			const dials = [0, 60 * S, 120 * S];
			const closes = [30 * S, 90 * S, 150 * S];
			expect(throttleWaitMs(dials, 180 * S, NEFARIOUS_RULE, closes)).to.equal(12 * S);
		});

		it("starts over when a close comes long after the chain", function () {
			const dials = [0, 10 * S, 20 * S];
			expect(throttleWaitMs(dials, 200 * S, NEFARIOUS_RULE, [190 * S])).to.equal(0);
		});

		it("does not care about the order dials were recorded in", function () {
			expect(throttleWaitMs([20 * S, 0, 10 * S], 30 * S, NEFARIOUS_RULE)).to.equal(32 * S);
		});

		describe("with the server's count (its registration notice)", function () {
			const rule = NEFARIOUS_RULE;

			it("takes the server's count where the replay counted more", function () {
				// The replay counts 3 (each drop within 42 s of the next dial),
				// the server reported 1 each time: another connection from the
				// address was open, so the drops moved nothing there.
				const dials = [0, 50 * S, 100 * S];
				const closes = [25 * S, 75 * S, 125 * S];
				const syncs: Sync[] = [
					[0, 1, 1 * S, 4],
					[50 * S, 1, 51 * S, 4],
					[100 * S, 1, 101 * S, 4],
				];
				expect(throttleWaitMs(dials, 150 * S, rule, closes)).to.equal(17 * S);
				expect(throttleWaitMs(dials, 150 * S, rule, closes, [], syncs)).to.equal(0);
			});

			it("takes the server's count where the replay counted less (dials it never saw)", function () {
				// Another device behind the address: the server is at 3 already,
				// and saw its last connection after our dial, so the gap runs from the report.
				expect(throttleWaitMs([0], 10 * S, rule, [], [], [[0, 3, 1 * S, 4]])).to.equal(
					33 * S
				);
			});

			it("runs the gap from the report when the server saw accepts we did not", function () {
				// Codex: our accept at 0, two others at 20 s and 30 s, our notice at 31 s says 3.
				const syncs: Sync[] = [[0, 3, 31 * S, 4]];
				expect(throttleWaitMs([0], 43 * S, rule, [], [], syncs)).to.equal(30 * S);
			});

			it("keeps the dials another tab made after this connection's dial (a late notice)", function () {
				// Codex: tab A dialled at 0, tab B dialled at 10 s and reported 2 at
				// 10.5 s; A's notice, sent before B's accept, arrives at 11 s saying 1.
				const dials = [0, 10 * S, 12 * S];
				const syncs: Sync[] = [
					[10 * S, 2, 10.5 * S, 4],
					[0, 1, 11 * S, 4],
				];
				expect(throttleWaitMs(dials, 13 * S, rule, [], [], syncs)).to.equal(41 * S);
			});

			it("counts a dial recorded before the report but accepted after it (another tab)", function () {
				// Codex: A dialled at 0, B recorded its dial at 5 but was accepted
				// at 12; A's report at 13 says 2. B counts on top: 3, gap from 13.
				const syncs: Sync[] = [[0, 2, 13 * S, 4]];
				expect(throttleWaitMs([0, 5 * S], 14 * S, rule, [], [], syncs)).to.equal(41 * S);
			});

			it("runs the gap from the report even when its count matches the replay's", function () {
				// Codex: a desktop stays on; our dials at 0, 50 and 100 (drops at
				// 25, 75 recorded) count 3 here, 1 on the server; two other
				// devices at 120 and 130; our report at 131 says 3.
				const syncs: Sync[] = [[100 * S, 3, 131 * S, 4]];
				const wait = throttleWaitMs(
					[0, 50 * S, 100 * S],
					143 * S,
					rule,
					[25 * S, 75 * S],
					[],
					syncs
				);
				expect(wait).to.equal(30 * S);
			});

			it("spends the refund budget on a refund the report already counts", function () {
				// Codex: one refund per 600 s. The refund at 10.5 s is in the
				// report at 11 s; the one at 20.5 s (no report) is past the cap.
				const capped = {...rule, refund: {limit: 1, periodMs: 600 * S}};
				const dials = [0, 10 * S, 20 * S, 22 * S];
				const refunds = [10.5 * S, 20.5 * S];
				const syncs: Sync[] = [[10 * S, 1, 11 * S, 4]];
				expect(throttleWaitMs(dials, 23 * S, capped, [], refunds, syncs)).to.equal(41 * S);
			});

			it("lets an older report raise the count, never lower it", function () {
				// Codex: A dials at 0, B at 5 and reports 2 at 6; another device
				// at 10; A reports 3 at 21. B's older report must not undo A's.
				const syncs: Sync[] = [
					[0, 3, 21 * S, 4],
					// Lower than it should be (it alone would let a dial in at 22 s).
					[5 * S, 1, 6 * S, 4],
				];
				expect(throttleWaitMs([0, 5 * S], 22 * S, rule, [], [], syncs)).to.be.greaterThan(
					0
				);
			});

			it("counts a dial recorded shortly before the report's own on top (it may come later)", function () {
				// Codex: A was offline at its dial, so its dial is recorded at the
				// open, 10 s; B recorded a dial at 5 that reached the server at 12;
				// A's report at 11 says 1; one more dial at 13.
				const syncs: Sync[] = [[10 * S, 1, 11 * S, 4]];
				const dials = [5 * S, 10 * S, 13 * S];
				expect(throttleWaitMs(dials, 14 * S, rule, [], [], syncs)).to.equal(41 * S);
			});

			it("counts the dials after the report on top of it", function () {
				const syncs: Sync[] = [[0, 2, 1 * S, 4]];
				expect(throttleWaitMs([0], 5 * S, rule, [], [], syncs)).to.equal(0);
				expect(throttleWaitMs([0, 10 * S], 15 * S, rule, [], [], syncs)).to.equal(37 * S);
			});

			it("takes the server's limit for the rest of the chain", function () {
				const dials = [0, 10 * S, 20 * S, 30 * S];
				const syncs: Sync[] = [[0, 1, 1 * S, 6]];
				expect(throttleWaitMs(dials, 35 * S, rule)).to.equal(37 * S);
				expect(throttleWaitMs(dials, 35 * S, rule, [], [], syncs)).to.equal(0);
				expect(throttleWaitMs([...dials, 40 * S], 45 * S, rule, [], [], syncs)).to.equal(
					37 * S
				);
			});

			it("forgets the server's limit when the chain starts over", function () {
				// A new chain at 100 s: until its own report, the rule's limit.
				const dials = [0, 100 * S, 110 * S, 120 * S];
				const syncs: Sync[] = [[0, 1, 1 * S, 6]];
				expect(throttleWaitMs(dials, 125 * S, rule, [], [], syncs)).to.equal(37 * S);
			});
		});

		describe("on a server that gives a login its attempt back (rule.refund)", function () {
			const rule = {...NEFARIOUS_RULE, refund: {limit: 10, periodMs: 600 * S}};

			it("does not grow the chain by a dial whose connection logged in", function () {
				// Three returns 30 s apart, each registered with SASL: the fourth gets in.
				const refunds = [1 * S, 31 * S, 61 * S];
				expect(throttleWaitMs([0, 30 * S, 60 * S], 90 * S, rule, [], refunds)).to.equal(0);
			});

			it("still counts the dials that did not log in", function () {
				expect(throttleWaitMs([0, 30 * S, 60 * S], 90 * S, rule, [], [1 * S])).to.equal(
					12 * S
				);
			});

			it("never takes the count below one, as the server does", function () {
				// Two refunds on the first dial change nothing: the chain still counts 3.
				expect(
					throttleWaitMs([0, 30 * S, 60 * S], 90 * S, rule, [], [1 * S, 2 * S])
				).to.equal(12 * S);
			});

			it("moves nothing but the count: the gap still runs from the last dial", function () {
				expect(
					throttleWaitMs([0, 30 * S, 60 * S], 90 * S, rule, [], [1 * S, 31 * S])
				).to.equal(0);
				// Without the second refund the fourth dial would wait.
				expect(throttleWaitMs([0, 30 * S, 60 * S], 90 * S, rule, [], [1 * S])).to.equal(
					12 * S
				);
			});

			it("mirrors the per-account cap: past `limit` refunds in a period the dials count again", function () {
				const capped = {...rule, refund: {limit: 2, periodMs: 600 * S}};
				const dials = [0, 30 * S, 60 * S, 90 * S, 120 * S];
				const refunds = [1 * S, 31 * S, 61 * S, 91 * S, 121 * S];
				// The first refund finds the count at one and gives nothing back;
				// 31 and 61 are honoured; 91 and 121 are past the cap: 1, 1, 1, 2, 3.
				expect(throttleWaitMs(dials, 150 * S, capped, [], refunds)).to.equal(12 * S);
			});

			it("gives the budget back a period after the refunds that spent it", function () {
				const capped = {...rule, refund: {limit: 2, periodMs: 600 * S}};
				const spent = [0, 30 * S, 60 * S, 90 * S, 120 * S];
				const spentRefunds = [1 * S, 31 * S, 61 * S, 91 * S, 121 * S];
				// A new chain: two returns 30 s apart, each logged in.
				const chain = (at: number) => [at, at + 30 * S, at + 60 * S, at + 90 * S];
				const chainRefunds = (at: number) => [at + 31 * S, at + 61 * S];
				const wait = (at: number, refunds: number[]) =>
					throttleWaitMs(
						[...spent, ...chain(at)],
						at + 120 * S,
						capped,
						[],
						[...spentRefunds, ...refunds]
					);
				// 600 s after 121, the last refund that would have lowered the count: honoured.
				expect(wait(700 * S, chainRefunds(700 * S))).to.equal(0);
				expect(wait(700 * S, [])).to.equal(12 * S);
				// Still inside that period: refused, the chain counts every dial.
				expect(wait(400 * S, chainRefunds(400 * S))).to.equal(12 * S);
			});

			it("spends nothing on a refund that finds the count at one (a return after a gap)", function () {
				const capped = {...rule, refund: {limit: 2, periodMs: 600 * S}};
				// Eleven returns a minute apart, each logged in: every one starts a
				// new chain, and its refund gives nothing back.
				const lone = Array.from({length: 11}, (_, i) => i * 60 * S);
				const dials = [...lone, 700 * S, 730 * S, 760 * S];
				const refunds = [...lone.map((t) => t + 1 * S), 731 * S, 761 * S];
				// So the budget is whole for the quick burst: 1, 1, 1.
				expect(throttleWaitMs(dials, 790 * S, capped, [], refunds)).to.equal(0);
			});

			it("never says dial where the server's cap would refuse (random histories)", function () {
				// The server's rule, as IPcheck.c and ipcheck_refund.c keep it: a
				// fixed window from the first granted refund, a refund granted only
				// while the count is above one. Whole seconds, no margin: the replay
				// must be at least as strict.
				const serverWait = (
					events: {at: number; kind: number}[],
					now: number,
					limit: number,
					refund: {limit: number; periodMs: number}
				) => {
					let attempts = 0;
					let last: number | undefined;
					let windowStart: number | undefined;
					let granted = 0;

					for (const {at, kind} of events) {
						if (kind === 2) {
							if (attempts > 1) {
								if (
									windowStart === undefined ||
									at - windowStart >= refund.periodMs
								) {
									windowStart = at;
									granted = 0;
								}

								if (granted < refund.limit) {
									granted++;
									attempts--;
								}
							}

							continue;
						}

						const since = last === undefined ? Infinity : at - last;

						if (kind === 1) {
							if (since > 40 * S) {
								attempts = 0;
							}

							attempts++;
						} else if (since > limit * 40 * S) {
							attempts = 0;
						}

						last = at;
					}

					if (last === undefined || now - last > 40 * S || attempts + 1 < limit) {
						return 0;
					}

					return last + 40 * S - now;
				};

				let seed = 7;

				const random = () => {
					seed = (seed * 1103515245 + 12345) % 2147483648;
					return seed / 2147483648;
				};

				for (let run = 0; run < 500; run++) {
					const limit = 1 + Math.floor(random() * 3);
					const refund = {limit, periodMs: (60 + Math.floor(random() * 600)) * S};
					const capped = {...NEFARIOUS_RULE, refund};
					const dials: number[] = [];
					const closes: number[] = [];
					const refunds: number[] = [];
					const events: {at: number; kind: number}[] = [];
					let t = 0;

					for (let step = 0; step < 40; step++) {
						t += Math.floor(random() * 50) * S;

						// Dial only when the replay says the server would let it in, as the transport does.
						if (throttleWaitMs(dials, t, capped, closes, refunds) > 0) {
							continue;
						}

						dials.push(t);
						events.push({at: t, kind: 1});

						if (random() < 0.7) {
							refunds.push(t + 1 * S);
							events.push({at: t + 1 * S, kind: 2});
						}

						if (random() < 0.5) {
							const drop = t + (2 + Math.floor(random() * 20)) * S;
							closes.push(drop);
							events.push({at: drop, kind: 0});
							t = drop;
						}

						events.sort((a, b) => a.at - b.at || a.kind - b.kind);
						const now = t + 2 * S;
						const replay = throttleWaitMs(dials, now, capped, closes, refunds);
						const server = serverWait(events, now, NEFARIOUS_RULE.limit, refund);

						if (server > 0) {
							expect(replay, `run ${run} step ${step} at ${now}`).to.be.greaterThan(
								0
							);
						}
					}
				}
			});

			it("ignores refunds under a rule without them", function () {
				const refunds = [1 * S, 31 * S, 61 * S];
				expect(
					throttleWaitMs([0, 30 * S, 60 * S], 90 * S, NEFARIOUS_RULE, [], refunds)
				).to.equal(12 * S);
			});
		});
	});

	describe("parseIpcheckNotice", function () {
		it("reads nefarious2's registration notice", function () {
			expect(parseIpcheckNotice("on 2 ca 1(6) ft 10(10) tr")).to.deep.equal({
				open: 2,
				count: 1,
				limit: 6,
			});
			expect(parseIpcheckNotice("on 1 ca 3(4) ft 7(10)")).to.deep.equal({
				open: 1,
				count: 3,
				limit: 4,
			});
		});

		it("ignores anything else", function () {
			expect(parseIpcheckNotice("on 2 ca 1(6)")).to.equal(undefined);
			expect(parseIpcheckNotice("you are on 2 ca 1(6) ft 10(10)")).to.equal(undefined);
			expect(parseIpcheckNotice("on 0 ca 1(6) ft 10(10)")).to.equal(undefined);
			expect(parseIpcheckNotice("on 1 ca 1(0) ft 10(10)")).to.equal(undefined);
			expect(parseIpcheckNotice("")).to.equal(undefined);
		});
	});

	describe("never says dial where the server would refuse (random histories, other connections)", function () {
		// IPcheck.c as it is: a dial resets the count after a gap of more than
		// the period since last_connect, then counts; the limit-th is refused
		// (and counted: IPCHECK_COUNT_REFUSALS). A close moves last_connect only
		// when it was the address's last connection, and resets the count
		// when that is more than limit × period after it. Whole seconds.
		class Server {
			attempts = 0;
			last = -Infinity;
			connected = 0;
			readonly limit: number;
			constructor(limit: number) {
				this.limit = limit;
			}
			dial(at: number): boolean {
				if (at - this.last > 40 * S) {
					this.attempts = 0;
				}

				this.last = at;
				this.attempts++;

				if (this.attempts >= this.limit) {
					return false;
				}

				this.connected++;
				return true;
			}
			close(at: number): void {
				if (--this.connected === 0) {
					if (at - this.last > this.limit * 40 * S) {
						this.attempts = 0;
					}

					this.last = at;
				}
			}
			wouldRefuse(at: number): boolean {
				return at - this.last <= 40 * S && this.attempts + 1 >= this.limit;
			}
		}

		let data: Map<string, string>;

		beforeEach(function () {
			data = new Map();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
		});

		afterEach(function () {
			useStorageBackend(null);
		});

		it("with every drop recorded and the counts the server reports", function () {
			let seed = 11;

			const random = () => {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				return seed / 2147483648;
			};

			for (let run = 0; run < 400; run++) {
				data.clear();
				const server = new Server(random() < 0.5 ? 4 : 6);
				const gate = dialGateFor(`run${run}.example`);
				// A desktop that stays connected from the same address the whole run.
				const desktop = random() < 0.5;
				// Another device dialled since the server last reported: no
				// client can know of it, so the check waits for the next report.
				let unseen = false;
				let t = 0;

				if (desktop) {
					server.dial(t);
				}

				for (let step = 0; step < 40; step++) {
					t += Math.floor(random() * 60) * S;

					// Another device's quick connection, unseen, just before ours.
					if (random() < 0.2) {
						if (server.dial(t)) {
							server.close(t + 1 * S);
						}

						unseen = true;
						t += 2 * S;
					}

					if (gate.waitMs(t) > 0) {
						continue;
					}

					if (!unseen) {
						expect(server.wouldRefuse(t), `run ${run} step ${step} at ${t}`).to.equal(
							false
						);
					}

					if (!server.dial(t)) {
						// Refused: no registration, no report; the transport records the end.
						gate.record(t);
						gate.closed(t);
						continue;
					}

					unseen = false;
					gate.record(t);
					const dialed = t;

					// Another device's connection accepted while ours registers:
					// the report counts it, the client never sees it.
					if (random() < 0.2) {
						t += Math.floor(random() * 5) * S;

						if (server.dial(t)) {
							server.close(t + 1 * S);
						}
					}

					t += 1 * S;
					gate.synced(dialed, t, server.attempts, server.limit);
					t += (1 + Math.floor(random() * 60)) * S;
					server.close(t);
					gate.closed(t);
				}
			}
		});
	});

	describe("dialGateFor", function () {
		let data: Map<string, string>;

		beforeEach(function () {
			data = new Map();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
		});

		afterEach(function () {
			useStorageBackend(null);
		});

		it("records dials per host, whatever the case", function () {
			const a = dialGateFor("IRC.Example");
			const b = dialGateFor("irc.example");
			a.record(0);
			b.record(10 * S);
			a.record(20 * S);
			expect(b.waitMs(30 * S)).to.equal(32 * S);
			expect(dialGateFor("other.example").waitMs(30 * S)).to.equal(0);
		});

		it("keeps the record across instances (a reopened app)", function () {
			dialGateFor("irc.example").record(0);
			dialGateFor("irc.example").record(10 * S);
			dialGateFor("irc.example").record(20 * S);
			expect(dialGateFor("irc.example").waitMs(30 * S)).to.equal(32 * S);
		});

		it("prunes dials too old to matter", function () {
			const gate = dialGateFor("irc.example");
			gate.record(0);
			gate.record(1000 * S);
			const stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"]).to.deep.equal({d: [1000 * S], c: [], r: []});
		});

		it("keeps the refunds it is told of, under a rule with them", function () {
			const rule = {...NEFARIOUS_RULE, refund: {limit: 10, periodMs: 600 * S}};
			const gate = dialGateFor("irc.example", rule);
			gate.record(0);
			gate.refunded(1 * S);
			gate.record(30 * S);
			gate.refunded(31 * S);
			gate.record(60 * S);
			gate.refunded(61 * S);
			expect(gate.waitMs(90 * S)).to.equal(0);
			const stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"].r).to.deep.equal([1 * S, 31 * S, 61 * S]);
		});

		it("records no refund for a server that gives none", function () {
			const gate = dialGateFor("irc.example");
			gate.record(0);
			gate.refunded(1 * S);
			const stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"]).to.deep.equal({d: [0], c: [], r: []});
		});

		it("keeps a chain of short connections whole, however long it runs", function () {
			// Three connections under 160 s each, 30 s apart: no drop restarts
			// the count (it outlived none of them), so the chain is 360 s long
			// and the next dial is refused — a fixed-age prune forgot its start.
			const gate = dialGateFor("irc.example");
			gate.record(0);
			gate.closed(150 * S);
			gate.record(180 * S);
			gate.closed(330 * S);
			gate.record(360 * S);
			gate.closed(510 * S);
			expect(gate.waitMs(520 * S)).to.equal(32 * S);
		});

		it("keeps the refunds a refund period before the chain, which decide its refunds", function () {
			const rule = {...NEFARIOUS_RULE, refund: {limit: 1, periodMs: 600 * S}};
			const gate = dialGateFor("irc.example", rule);
			// A refund that lowered the count spends the account's one refund.
			gate.record(-10 * S);
			gate.record(0);
			gate.refunded(1 * S);
			// A new chain: its refunds are past the cap, so the count runs 1, 2, 3.
			gate.record(530 * S);
			gate.record(550 * S);
			gate.refunded(551 * S);
			gate.record(570 * S);
			gate.refunded(571 * S);
			gate.closed(601 * S);
			expect(gate.waitMs(605 * S)).to.equal(38 * S);
		});

		it("keeps at most a bounded record per host", function () {
			const gate = dialGateFor("irc.example");

			for (let i = 0; i < 250; i++) {
				gate.record(i * 30 * S);
			}

			const stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"].d).to.have.length(200);
			expect(stored["irc.example"].d[199]).to.equal(249 * 30 * S);
		});

		it("keeps refunds for the refund period, which outlasts a chain", function () {
			const rule = {...NEFARIOUS_RULE, refund: {limit: 2, periodMs: 600 * S}};
			const gate = dialGateFor("irc.example", rule);
			gate.refunded(0);
			gate.record(300 * S);
			let stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"].r).to.deep.equal([0]);
			gate.record(700 * S);
			stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"].r).to.deep.equal([]);
		});

		it("ignores dials recorded in the future (a clock that ran ahead)", function () {
			const gate = dialGateFor("irc.example");
			gate.record(3600 * S);
			gate.record(3610 * S);
			gate.record(3620 * S);
			expect(gate.waitMs(0)).to.equal(0);
		});

		it("keeps the closes it is told of, with the dials", function () {
			const gate = dialGateFor("irc.example");
			gate.record(0);
			gate.closed(30 * S);
			gate.record(60 * S);
			gate.closed(90 * S);
			gate.record(120 * S);
			gate.closed(150 * S);
			expect(dialGateFor("irc.example").waitMs(180 * S)).to.equal(12 * S);
		});

		it("takes the server's limit from its report, and drops it with the chain", function () {
			const gate = dialGateFor("irc.example");
			gate.record(0);
			gate.synced(0, 1 * S, 1, 6);
			gate.record(10 * S);
			gate.record(20 * S);
			gate.record(30 * S);
			// Four in the chain: the default limit would hold the fifth, AfterNET's 6 does not.
			expect(gate.waitMs(35 * S)).to.equal(0);
			gate.record(40 * S);
			expect(gate.waitMs(45 * S)).to.equal(37 * S);
			gate.record(1000 * S);
			const stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"]).to.deep.equal({d: [1000 * S], c: [], r: []});
		});

		it("keeps a report that came after a later dial started the record (Codex)", function () {
			const gate = dialGateFor("irc.example");
			gate.record(0);
			gate.record(50 * S);
			gate.synced(0, 51 * S, 3, 4);
			gate.closed(60 * S);
			expect(gate.waitMs(61 * S)).to.be.greaterThan(0);
		});

		it("keeps the server's reports with the chain", function () {
			const gate = dialGateFor("irc.example");
			gate.record(0);
			gate.synced(0, 1 * S, 1, 4);
			gate.closed(20 * S);
			gate.record(50 * S);
			gate.synced(50 * S, 51 * S, 1, 4);
			const stored = JSON.parse(data.get("thelounge.state.dials") ?? "{}");
			expect(stored["irc.example"].s).to.deep.equal([
				[0, 1, 1 * S, 4],
				[50 * S, 1, 51 * S, 4],
			]);
		});

		it("ignores a broken report", function () {
			data.set(
				"thelounge.state.dials",
				JSON.stringify({
					"irc.example": {d: [0, 10 * S, 20 * S], s: [[1, "x", 2, 6], 5, [0, 1, 1, 0]]},
				})
			);
			expect(dialGateFor("irc.example").waitMs(30 * S)).to.equal(32 * S);
		});

		it("survives a broken record", function () {
			data.set("thelounge.state.dials", "{not json");
			expect(dialGateFor("irc.example").waitMs(0)).to.equal(0);
		});
	});

	describe("wired into the client", function () {
		let clock: sinon.SinonFakeTimers;

		beforeEach(function () {
			clock = sinon.useFakeTimers({now: Date.parse("2026-10-22T12:00:00.000Z")});
		});

		afterEach(function () {
			clock.restore();
		});

		/** The options the client builds its transport with. */
		let lastClient: ReturnType<typeof setup>["client"];

		function transportOptions(): TransportOptions {
			let captured: TransportOptions | undefined;
			const h = setup({
				transportFactory(opts) {
					captured = opts;
					return new FakeTransport();
				},
			});
			h.client.connect();
			lastClient = h.client;
			return captured as TransportOptions;
		}

		it("gives the transport a gate for the network's host", function () {
			expect(transportOptions().gate).to.not.equal(undefined);
		});

		it("does not record the drop of a session the bouncer holds (the server keeps it counted)", function () {
			const data = new Map<string, string>();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
			const opts = transportOptions();

			const closes = (): number[] => {
				const all = JSON.parse(data.get("thelounge.state.dials") ?? "{}") as Record<
					string,
					{c?: number[]}
				>;
				return all["irc.test"]?.c ?? [];
			};

			const client = lastClient;
			client.persistenceHold = true;
			opts.gate!.closed(1000);
			expect(closes()).to.deep.equal([]);
			client.persistenceHold = false;
			opts.gate!.closed(2000);
			expect(closes()).to.deep.equal([2000]);
			useStorageBackend(null);
		});

		it("records the drop a page unload makes, for a session not held", function () {
			const data = new Map<string, string>();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
			transportOptions();
			lastClient.noteUnload();
			const record = JSON.parse(data.get("thelounge.state.dials") ?? "{}")["irc.test"];
			expect(record?.c).to.deep.equal([Date.now()]);
			useStorageBackend(null);
		});

		it("records no unload drop for a held session, nor for a socket already gone", function () {
			const data = new Map<string, string>();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
			transportOptions();
			lastClient.persistenceHold = true;
			lastClient.noteUnload();
			lastClient.persistenceHold = false;
			(lastClient.transport as FakeTransport).state = "closed";
			lastClient.noteUnload();
			const record = JSON.parse(data.get("thelounge.state.dials") ?? "{}")["irc.test"];
			expect(record?.c ?? []).to.deep.equal([]);
			useStorageBackend(null);
		});

		it("takes the server's notice: its count from the connection's dial, and its limit", function () {
			const data = new Map<string, string>();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
			let captured: TransportOptions | undefined;
			const fake = new FakeTransport();
			const h = {
				...setup({
					transportFactory(opts) {
						captured = opts;
						return fake;
					},
				}),
				transport: fake,
			};
			const dialed = Date.now();
			captured!.gate!.record(dialed);
			register(h);
			clock.tick(2000);
			h.transport.line(":irc.test NOTICE alice :on 2 ca 1(6) ft 10(10) tr");
			const record = (
				JSON.parse(data.get("thelounge.state.dials") ?? "{}") as Record<
					string,
					{s?: Sync[]}
				>
			)["irc.test"];
			expect(record?.s).to.deep.equal([[dialed, 1, dialed + 2000, 6]]);
			// Still shown.
			expect(h.lastMessage(h.client.lobby.id).text).to.contain("on 2 ca 1(6)");
			useStorageBackend(null);
		});

		it("takes no notice of a user who sends the same text", function () {
			const data = new Map<string, string>();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
			const h = setup();
			register(h);
			h.transport.line(":mallory!m@h NOTICE alice :on 2 ca 1(6) ft 10(10) tr");
			expect(data.get("thelounge.state.dials") ?? "").to.not.contain('"s"');
			useStorageBackend(null);
		});

		it("a KILL of our own connection ends the hold: a killed session is never held", function () {
			const h = setup();
			register(h);
			h.client.persistenceHold = true;
			h.transport.line(":oper!o@h KILL someone :irc.test!oper (spam)");
			expect(h.client.persistenceHold).to.equal(true);
			h.transport.line(":oper!o@h KILL alice :irc.test!oper (spam)");
			expect(h.client.persistenceHold).to.equal(false);
		});

		it("says a wait is the server's throttle, and drops that once the dial starts", function () {
			const h = setup();
			register(h);
			h.transport.event({
				type: "close",
				code: 1006,
				reason: "",
				wasClean: false,
				willReconnect: true,
				delayMs: 30_000,
			});
			h.transport.event({type: "reconnecting", attempt: 1, delayMs: 30_000, throttled: true});
			const status =
				h.payloads<{retryAt?: number; retryThrottled?: boolean}>("network:status");
			expect(status[status.length - 1]).to.include({
				retryAt: Date.now() + 30_000,
				retryThrottled: true,
			});
			expect(h.lastMessage(h.client.lobby.id).text).to.match(/limits how often/);

			h.transport.event({type: "retry", attempt: 1});
			const after = h.payloads<{retryThrottled?: boolean}>("network:status");
			expect(after[after.length - 1].retryThrottled).to.equal(undefined);
		});

		it("shows the due time of a throttled connect() that no close came before", function () {
			const h = setup();
			h.transport.event({type: "reconnecting", attempt: 0, delayMs: 20_000, throttled: true});
			const status =
				h.payloads<{retryAt?: number; retryThrottled?: boolean}>("network:status");
			expect(status[status.length - 1]).to.include({
				retryAt: Date.now() + 20_000,
				retryThrottled: true,
			});
		});

		it("keeps a plain backoff wait unmarked", function () {
			const h = setup();
			register(h);
			h.transport.event({
				type: "close",
				code: 1006,
				reason: "",
				wasClean: false,
				willReconnect: true,
				delayMs: 4_000,
			});
			h.transport.event({type: "reconnecting", attempt: 3, delayMs: 4_000});
			const status = h.payloads<{retryThrottled?: boolean}>("network:status");
			expect(status[status.length - 1].retryThrottled).to.equal(undefined);
		});
	});
});
