import {expect} from "chai";
import sinon from "sinon";
import {
	TypingExpiry,
	TYPING_SWEEP_INTERVAL,
	type TypingHolder,
} from "../../client/js/helpers/typingExpiry";
import {
	applyTyping,
	TYPING_ACTIVE_TTL,
	TYPING_PAUSED_TTL,
} from "../../client/js/helpers/typingState";

describe("typing expiry sweep", function () {
	let clock: sinon.SinonFakeTimers;
	let channels: TypingHolder[];
	let expiry: TypingExpiry;

	const chan = (): TypingHolder => ({typing: []});

	const type = (holder: TypingHolder, nick: string, state: "active" | "paused" = "active") => {
		holder.typing = applyTyping(holder.typing, nick, state, Date.now());

		expiry.schedule();
	};

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: 1_000_000});
		channels = [chan(), chan(), chan()];
		expiry = new TypingExpiry(() => channels);
	});

	afterEach(function () {
		expiry.dispose();
		clock.restore();
	});

	it("prunes a background channel whose typist never said done", function () {
		// The channel on screen is the only one with a mounted TypingIndicator;
		// this is the case that used to leave an entry behind forever.
		type(channels[1], "alice");

		clock.tick(TYPING_ACTIVE_TTL - TYPING_SWEEP_INTERVAL);
		expect(channels[1].typing).to.have.lengthOf(1);

		// the sweep that lands on the expiry itself drops it
		clock.tick(TYPING_SWEEP_INTERVAL);
		expect(channels[1].typing).to.be.empty;
	});

	it("sweeps every channel, not just one", function () {
		type(channels[0], "alice");
		type(channels[2], "bob");

		clock.tick(TYPING_ACTIVE_TTL + TYPING_SWEEP_INTERVAL);
		expect(channels[0].typing).to.be.empty;
		expect(channels[2].typing).to.be.empty;
	});

	it("keeps entries that are still live and drops only the stale ones", function () {
		type(channels[0], "alice", "paused");
		clock.tick(TYPING_ACTIVE_TTL);
		type(channels[0], "bob", "active");

		// alice is paused (30 s), bob active (6 s): only bob lapses here
		clock.tick(TYPING_ACTIVE_TTL + TYPING_SWEEP_INTERVAL);
		expect(channels[0].typing.map((e) => e.nick)).to.deep.equal(["alice"]);
		expect(expiry.running).to.be.true;

		clock.tick(TYPING_PAUSED_TTL);
		expect(channels[0].typing).to.be.empty;
	});

	it("runs only while something is typing, and restarts on the next notification", function () {
		expect(expiry.running).to.be.false;

		type(channels[0], "alice");
		expect(expiry.running).to.be.true;

		clock.tick(TYPING_ACTIVE_TTL + TYPING_SWEEP_INTERVAL);
		expect(expiry.running).to.be.false;

		type(channels[0], "bob");
		expect(expiry.running).to.be.true;
	});

	it("leaves the array identity alone when nothing expired", function () {
		type(channels[0], "alice");
		const before = channels[0].typing;

		clock.tick(TYPING_SWEEP_INTERVAL);
		// Same reference: reactive watchers must not fire on a no-op sweep.
		expect(channels[0].typing).to.equal(before);
	});

	it("stops the ticker when disposed", function () {
		type(channels[0], "alice");
		expiry.dispose();
		expect(expiry.running).to.be.false;

		clock.tick(TYPING_ACTIVE_TTL + TYPING_SWEEP_INTERVAL);
		expect(channels[0].typing).to.have.lengthOf(1);
	});
});
