import {expect} from "chai";
import sinon from "ts-sinon";
import {
	BACKGROUND_BUDGET_MS,
	BackgroundQueue,
	FakeLagClock,
	IRCU_FAKE_LAG,
	NO_FAKE_LAG,
} from "../../client/js/irc/fakelag";

describe("Fake-lag clock and background queue (irc/fakelag.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: Date.parse("2026-10-19T12:00:00.000Z")});
	});

	afterEach(function () {
		clock.restore();
	});

	describe("FakeLagClock", function () {
		it("charges nothing before registration", function () {
			const lag = new FakeLagClock(IRCU_FAKE_LAG);
			lag.charge("CAP LS 302");
			lag.charge("NICK alice");
			expect(lag.ahead()).to.equal(0);
		});

		it("charges 2 s plus a second per 120 bytes, as parse.c does", function () {
			const lag = new FakeLagClock(IRCU_FAKE_LAG);
			lag.start();
			lag.charge("JOIN #a");
			expect(lag.ahead()).to.equal(2000);
			// 238 bytes + CRLF = 240: 2 + 240/120 = 4 s.
			lag.charge("PRIVMSG #a :" + "x".repeat(226));
			expect(lag.ahead()).to.equal(6000);
		});

		it("charges a multiline batch's opener, not its lines, and a flat 2 s at its close", function () {
			const lag = new FakeLagClock(IRCU_FAKE_LAG);
			lag.start();
			lag.charge("@label=s1 BATCH +m1 draft/multiline #seance");
			expect(lag.ahead()).to.equal(2000);

			for (let i = 0; i < 10; i++) {
				lag.charge(`@batch=m1 PRIVMSG #seance :line ${i}`);
			}

			expect(lag.ahead()).to.equal(2000);
			lag.charge("BATCH -m1");
			expect(lag.ahead()).to.equal(4000);
		});

		it("charges a multiline close 2 s whatever the class says, fake lag off included", function () {
			// m_batch.c MULTILINE_COOLDOWN_BASE: a constant, added to the
			// clock with no regard to fakelagminimum or fakelagfactor.
			for (const model of [{min: 5, factor: 120, ceiling: 10}, NO_FAKE_LAG]) {
				const lag = new FakeLagClock(model);
				lag.start();
				lag.charge("@label=s1 BATCH +m1 draft/multiline #seance");
				lag.charge("@batch=m1 PRIVMSG #seance :line");
				const before = lag.ahead();
				lag.charge("BATCH -m1");
				expect(lag.ahead() - before, `min ${model.min}`).to.equal(2000);
			}
		});

		it("never runs behind wall time, so idle time is not banked", function () {
			const lag = new FakeLagClock(IRCU_FAKE_LAG);
			lag.start();
			lag.charge("JOIN #a");
			clock.tick(1500);
			expect(lag.ahead()).to.equal(500);
			clock.tick(60_000);
			expect(lag.ahead()).to.equal(0);
			lag.charge("JOIN #b");
			expect(lag.ahead()).to.equal(2000);
		});

		it("charges no command with fake lag off (fakelagfactor = 0), nor after the close", function () {
			const off = new FakeLagClock(NO_FAKE_LAG);
			off.start();
			off.charge("JOIN #a");
			expect(off.ahead()).to.equal(0);

			const lag = new FakeLagClock(IRCU_FAKE_LAG);
			lag.start();
			lag.charge("JOIN #a");
			lag.stop();
			expect(lag.ahead()).to.equal(0);
		});

		it("says how long until a cost fits the budget", function () {
			const lag = new FakeLagClock(IRCU_FAKE_LAG);
			lag.start();
			lag.charge("A");
			lag.charge("B");
			lag.charge("C"); // 6 s ahead
			expect(lag.waitFor(2000)).to.equal(4000); // to 2 s ahead, +2 = the budget
			expect(lag.waitFor(4000)).to.equal(6000);
			expect(lag.waitFor(8000)).to.equal(6000); // larger than the budget: once drained
		});
	});

	describe("BackgroundQueue", function () {
		function queue(ready = () => true) {
			const lag = new FakeLagClock(IRCU_FAKE_LAG);
			lag.start();
			const sent: string[] = [];
			const q = new BackgroundQueue(lag, ready);
			const job = (key: string, cost = 2000) => ({
				key,
				cost,
				run() {
					sent.push(key);
					lag.charge(key);
				},
			});
			return {lag, q, sent, job};
		}

		it("sends what fits now and the rest as the clock drains, never past the budget", function () {
			const {lag, q, sent, job} = queue();
			q.add(job("a"));
			q.add(job("b"));
			q.add(job("c"));
			expect(sent).to.deep.equal(["a", "b"]);
			expect(lag.ahead()).to.equal(BACKGROUND_BUDGET_MS);
			clock.tick(1999);
			expect(sent).to.deep.equal(["a", "b"]);
			clock.tick(1);
			expect(sent).to.deep.equal(["a", "b", "c"]);
			expect(lag.ahead()).to.be.at.most(BACKGROUND_BUDGET_MS);
		});

		it("makes room after the user's own lines instead of on a fixed beat", function () {
			const {lag, q, sent, job} = queue();
			lag.charge("PRIVMSG #a :one");
			lag.charge("PRIVMSG #a :two");
			lag.charge("PRIVMSG #a :three"); // 6 s ahead
			q.add(job("a"));
			expect(sent).to.deep.equal([]);
			clock.tick(4000);
			expect(sent).to.deep.equal(["a"]);
		});

		it("replaces a job with the same key in place; take and drop remove", function () {
			const {lag, q, sent, job} = queue();
			lag.charge("X");
			lag.charge("Y");
			lag.charge("Z");
			q.add(job("a"));
			q.add(job("b"));
			q.add({...job("a"), run: () => sent.push("a2")});
			q.add(job("front"), {front: true});
			expect(q.keys()).to.deep.equal(["front", "a", "b"]);
			expect(q.take("b")?.key).to.equal("b");
			q.drop((k) => k === "front");
			clock.tick(10_000);
			expect(sent).to.deep.equal(["a2"]);
		});

		it("keeps a `last` job behind every other, however late those are queued", function () {
			const {lag, q, job} = queue();
			lag.charge("X");
			lag.charge("Y");
			lag.charge("Z"); // nothing goes out yet
			q.add({...job("q1"), last: true});
			q.add(job("a"));
			q.add({...job("q2"), last: true});
			q.add(job("b"));
			q.add(job("c"), {ahead: (k) => k === "b"});
			q.add(job("front"), {front: true});
			q.add(job("d"), {ahead: (k) => k === "nothing"});
			expect(q.keys()).to.deep.equal(["front", "a", "c", "b", "d", "q1", "q2"]);
		});

		it("waits while the socket cannot take commands, and sends on the next pump", function () {
			let ready = false;
			const {q, sent, job} = queue(() => ready);
			q.add(job("a"));
			clock.tick(10_000);
			expect(sent).to.deep.equal([]);
			ready = true;
			q.pump();
			expect(sent).to.deep.equal(["a"]);
		});
	});
});
