import {expect} from "chai";
import sinon from "sinon";
import {
	ACTIVITY_PULSE_MS,
	ACTIVITY_SWEEP_INTERVAL,
	ActivityExpiry,
	isActivity,
	noteActivity,
	type ActivityHolder,
} from "../../client/js/helpers/activityPulse";
import {MessageType} from "../../shared/types/msg";

describe("sidebar activity pulse", function () {
	describe("what counts as activity", function () {
		it("pulses for someone talking", function () {
			for (const type of [
				MessageType.MESSAGE,
				MessageType.ACTION,
				MessageType.NOTICE,
				MessageType.WALLOPS,
			]) {
				expect(isActivity({type}), type).to.be.true;
			}
		});

		it("stays still for joins, parts and the rest of the furniture", function () {
			for (const type of [
				MessageType.JOIN,
				MessageType.PART,
				MessageType.QUIT,
				MessageType.KICK,
				MessageType.NICK,
				MessageType.MODE,
				MessageType.MODE_CHANNEL,
				MessageType.MODE_USER,
				MessageType.TOPIC,
				MessageType.TOPIC_SET_BY,
				MessageType.AWAY,
				MessageType.BACK,
				MessageType.CHGHOST,
				MessageType.CTCP,
				MessageType.CTCP_REQUEST,
				MessageType.WHOIS,
				MessageType.MONOSPACE_BLOCK,
				MessageType.RAW,
				MessageType.ERROR,
			]) {
				expect(isActivity({type}), type).to.be.false;
			}
		});

		it("does not pulse for our own messages", function () {
			expect(isActivity({type: MessageType.MESSAGE, self: true})).to.be.false;
			expect(isActivity({type: MessageType.ACTION, self: true})).to.be.false;
		});

		it("treats a message with no type as a message", function () {
			// The IRC layer leaves `type` off plain PRIVMSGs in places, and
			// pushMessage defaults it the same way.
			expect(isActivity({})).to.be.true;
		});
	});

	describe("expiry sweep", function () {
		let clock: sinon.SinonFakeTimers;
		let channels: ActivityHolder[];
		let expiry: ActivityExpiry;

		const chan = (): ActivityHolder => ({activityUntil: 0});

		const speak = (holder: ActivityHolder) => {
			noteActivity(holder, Date.now());
			expiry.schedule();
		};

		beforeEach(function () {
			clock = sinon.useFakeTimers({now: 1_000_000});
			channels = [chan(), chan(), chan()];
			expiry = new ActivityExpiry(() => channels);
		});

		afterEach(function () {
			expiry.dispose();
			clock.restore();
		});

		it("pulses a background channel and stops on its own", function () {
			speak(channels[1]);

			clock.tick(ACTIVITY_PULSE_MS - ACTIVITY_SWEEP_INTERVAL);
			expect(channels[1].activityUntil).to.be.greaterThan(0);

			// the sweep that lands on the deadline itself clears it
			clock.tick(ACTIVITY_SWEEP_INTERVAL);
			expect(channels[1].activityUntil).to.equal(0);
		});

		it("sweeps every channel, not just one", function () {
			speak(channels[0]);
			speak(channels[2]);

			clock.tick(ACTIVITY_PULSE_MS + ACTIVITY_SWEEP_INTERVAL);
			expect(channels[0].activityUntil).to.equal(0);
			expect(channels[2].activityUntil).to.equal(0);
		});

		it("extends the pulse when the channel keeps talking", function () {
			speak(channels[0]);

			clock.tick(ACTIVITY_PULSE_MS - ACTIVITY_SWEEP_INTERVAL);
			speak(channels[0]);

			// would have lapsed on the original deadline; the second message
			// pushed it out instead
			clock.tick(ACTIVITY_SWEEP_INTERVAL * 2);
			expect(channels[0].activityUntil).to.be.greaterThan(0);

			clock.tick(ACTIVITY_PULSE_MS);
			expect(channels[0].activityUntil).to.equal(0);
		});

		it("keeps a live channel pulsing while a quiet one lapses", function () {
			speak(channels[0]);
			clock.tick(ACTIVITY_PULSE_MS - ACTIVITY_SWEEP_INTERVAL);
			speak(channels[2]);

			clock.tick(ACTIVITY_SWEEP_INTERVAL);
			expect(channels[0].activityUntil).to.equal(0);
			expect(channels[2].activityUntil).to.be.greaterThan(0);
			expect(expiry.running).to.be.true;
		});

		it("runs only while something is pulsing, and restarts on the next message", function () {
			expect(expiry.running).to.be.false;

			speak(channels[0]);
			expect(expiry.running).to.be.true;

			clock.tick(ACTIVITY_PULSE_MS + ACTIVITY_SWEEP_INTERVAL);
			expect(expiry.running).to.be.false;

			speak(channels[0]);
			expect(expiry.running).to.be.true;
		});

		it("leaves the deadline alone when nothing lapsed", function () {
			speak(channels[0]);
			const before = channels[0].activityUntil;

			clock.tick(ACTIVITY_SWEEP_INTERVAL);
			// Untouched: reactive watchers must not fire on a no-op sweep.
			expect(channels[0].activityUntil).to.equal(before);
		});

		it("stops the ticker when disposed", function () {
			speak(channels[0]);
			expiry.dispose();
			expect(expiry.running).to.be.false;

			clock.tick(ACTIVITY_PULSE_MS + ACTIVITY_SWEEP_INTERVAL);
			expect(channels[0].activityUntil).to.be.greaterThan(0);
		});
	});
});
