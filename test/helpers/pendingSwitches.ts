import {expect} from "chai";
import sinon from "sinon";
import {PendingSwitches} from "../../client/js/helpers/pendingSwitches";

describe("pending switches (helpers/pendingSwitches.ts)", function () {
	let clock: sinon.SinonFakeTimers;
	let umodes: string;
	let switches: PendingSwitches;
	const has = (letter: string) => umodes.includes(letter);

	beforeEach(function () {
		clock = sinon.useFakeTimers();
		umodes = "o";
		switches = new PendingSwitches(4000);
	});

	afterEach(function () {
		switches.dispose();
		clock.restore();
	});

	it("shows the real mode when nothing was asked", function () {
		expect(switches.shown("I", has("I"))).to.equal(false);
		expect(switches.shown("o", has("o"))).to.equal(true);
	});

	it("holds the asked-for state until the server's MODE matches it", function () {
		switches.request("I", true);
		expect(switches.shown("I", has("I"))).to.equal(true);
		umodes = "oI";
		switches.reconcile(has);
		expect(switches.isPending("I")).to.equal(false);
		expect(switches.shown("I", has("I"))).to.equal(true);
		expect(clock.countTimers()).to.equal(0);
	});

	it("goes back to the real mode when the server refuses in silence", function () {
		switches.request("I", true);
		clock.tick(3999);
		expect(switches.shown("I", has("I"))).to.equal(true);
		clock.tick(1);
		expect(switches.shown("I", has("I"))).to.equal(false);
	});

	it("keeps waiting through an unrelated mode change", function () {
		switches.request("I", true);
		umodes = "ow";
		switches.reconcile(has);
		expect(switches.isPending("I")).to.equal(true);
	});

	it("works for switching a mode off", function () {
		umodes = "oI";
		switches.request("I", false);
		expect(switches.shown("I", has("I"))).to.equal(false);
		clock.tick(4000); // refused: still on
		expect(switches.shown("I", has("I"))).to.equal(true);
	});

	it("a second tap restarts the wait with the new state", function () {
		switches.request("I", true);
		clock.tick(3000);
		switches.request("I", false);
		clock.tick(3000);
		expect(switches.shown("I", true)).to.equal(false);
		clock.tick(1000);
		expect(switches.isPending("I")).to.equal(false);
	});

	it("waits longer for a tap queued behind others: the server answers in order, ~2 s each", function () {
		switches.request("I", true);
		switches.request("w", true);
		switches.request("g", true);

		// 4 s, then 2 s more for each tap ahead: 4, 6 and 8 s.
		clock.tick(4000);
		expect(switches.isPending("I")).to.equal(false);
		expect(switches.isPending("w")).to.equal(true);
		clock.tick(2000);
		expect(switches.isPending("w")).to.equal(false);
		// The third MODE comes ~6 s after its tap: still held then.
		expect(switches.shown("g", has("g"))).to.equal(true);

		umodes = "og";
		switches.reconcile(has);
		expect(switches.isPending("g")).to.equal(false);
		expect(switches.shown("g", has("g"))).to.equal(true);
	});

	it("re-renders a Vue reader when a request settles (wrapped in reactive)", async function () {
		const {reactive, effect} = await import("vue");
		const live = reactive(new PendingSwitches(4000));
		let seen: boolean[] = [];
		const runner = effect(() => {
			seen.push(live.shown("I", has("I")));
		});

		live.request("I", true);
		clock.tick(4000);
		expect(seen).to.deep.equal([false, true, false]);
		runner.effect.stop();
		live.dispose();
		seen = [];
	});
});
