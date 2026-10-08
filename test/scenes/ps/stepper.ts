import {expect} from "chai";
import sinon from "sinon";
import {
	createStepper,
	SCENE_FPS,
	SPARSE_INTERVAL_MS,
	keepPhase,
	stepModeFor,
	type StepAnimation,
	type StepMode,
} from "../../../client/js/scenes/ps/stepper";

class FakeAnimation implements StepAnimation {
	playState = "running";
	private time: number | null;

	constructor(start = 0) {
		this.time = start;
	}

	get currentTime(): number | null {
		return this.time;
	}

	/** As the browser does: a time written to a cancelled animation brings it back, held. */
	set currentTime(value: number | null) {
		this.time = value;

		if (this.playState === "idle") {
			this.playState = "paused";
		}
	}

	pause() {
		this.playState = "paused";
	}

	play() {
		this.playState = "running";
	}

	listeners: Array<() => void> = [];

	addEventListener(_type: "cancel", listener: () => void) {
		this.listeners.push(listener);
	}

	cancel() {
		this.playState = "idle";
	}

	/** What the browser does when the element's style drops the animation: idle, and a cancel event after. */
	cancelledByStyle() {
		this.playState = "idle";
	}

	fireCancel() {
		this.listeners.forEach((l) => l());
	}
}

class FakeSvg {
	paused = false;
	time = 0;

	animationsPaused() {
		return this.paused;
	}

	pauseAnimations() {
		this.paused = true;
	}

	unpauseAnimations() {
		this.paused = false;
	}

	getCurrentTime() {
		return this.time;
	}

	setCurrentTime(seconds: number) {
		this.time = seconds;
	}
}

describe("ps scene: the stepper (stepper.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers();
	});

	afterEach(function () {
		clock.restore();
	});

	const stepper = (anims: FakeAnimation[], svgs: FakeSvg[], mode?: StepMode) =>
		createStepper({
			mode,
			animations: () => anims,
			svgs: () => svgs,
			now: () => Date.now(),
			after(ms, fn) {
				const id = setTimeout(fn, ms);
				return () => clearTimeout(id);
			},
		});

	it("draws at 24 frames a second", function () {
		expect(SCENE_FPS).to.equal(24);
	});

	it("holds every animation and SVG clock, and advances them by the real time elapsed", function () {
		const a = new FakeAnimation(500);
		const svg = new FakeSvg();
		const s = stepper([a], [svg]);
		s.start();
		expect(a.playState, "held").to.equal("paused");
		expect(svg.paused, "held").to.equal(true);
		clock.tick(1000);
		expect(a.currentTime).to.be.closeTo(1500, 1000 / SCENE_FPS);
		expect(svg.time).to.be.closeTo(1, 1 / SCENE_FPS);
		s.stop();
	});

	it("steps SCENE_FPS times a second, not at the screen's rate", function () {
		const a = new FakeAnimation();
		let writes = 0;
		Object.defineProperty(a, "currentTime", {
			get: () => 0,
			set: () => (writes += 1),
		});
		const s = stepper([a], []);
		s.start();
		clock.tick(1000);
		expect(writes).to.be.within(SCENE_FPS - 1, SCENE_FPS);
		s.stop();
	});

	it("leaves no timer when stopped, and resumes from where it stood", function () {
		const a = new FakeAnimation();
		const s = stepper([a], []);
		s.start();
		clock.tick(1000);
		s.stop();
		expect(clock.countTimers()).to.equal(0);
		expect(s.running).to.equal(false);
		const held = a.currentTime as number;
		clock.tick(60000); // a minute at rest
		expect(a.currentTime).to.equal(held);
		s.start();
		clock.tick(500);
		expect(a.currentTime, "no jump by the rest's length").to.be.closeTo(
			held + 500,
			1000 / SCENE_FPS
		);
		s.stop();
	});

	it("takes in what a refresh finds and lets go of what it no longer finds", function () {
		const anims = [new FakeAnimation()];
		const s = stepper(anims, []);
		s.start();
		const late = new FakeAnimation(200);
		const gone = anims[0];
		anims.splice(0, 1, late);
		s.refresh();
		expect(late.playState).to.equal("paused");
		const goneAt = gone.currentTime;
		clock.tick(1000);
		expect(late.currentTime).to.be.closeTo(1200, 1000 / SCENE_FPS);
		expect(gone.currentTime, "no longer stepped").to.equal(goneAt);
		s.stop();
	});

	it("never reads an animation back in a step", function () {
		const a = new FakeAnimation();
		let reads = 0;
		let value: number | null = 0;
		Object.defineProperty(a, "currentTime", {
			get() {
				reads += 1;
				return value;
			},
			set: (v: number) => (value = v),
		});
		const s = stepper([a], []);
		s.start(); // the refresh reads it once
		const afterRefresh = reads;
		clock.tick(1000);
		expect(reads).to.equal(afterRefresh);
		s.stop();
	});

	it("starts once however often it is asked", function () {
		const s = stepper([], []);
		s.start();
		s.start();
		expect(clock.countTimers()).to.equal(1);
		s.stop();
	});

	describe("the Scene animation setting's paces (stepModeFor)", function () {
		it("maps each level: off never runs, sparse every five minutes catching up, 1s, 24, and 60 the browser's own", function () {
			expect(stepModeFor("off")).to.equal(null);
			expect(stepModeFor("sparse")).to.deep.equal({
				kind: "step",
				interval: SPARSE_INTERVAL_MS,
				catchUp: true,
			});
			expect(SPARSE_INTERVAL_MS).to.equal(5 * 60 * 1000);
			expect(stepModeFor("1s")).to.deep.equal({kind: "step", interval: 1000, catchUp: false});
			expect(stepModeFor("24")).to.deep.equal({
				kind: "step",
				interval: 1000 / 24,
				catchUp: false,
			});
			expect(stepModeFor("60")).to.deep.equal({kind: "native"});
		});

		it("60: hands playback to the browser, with no timer, and holds everything again when stopped", function () {
			const a = new FakeAnimation();
			const svg = new FakeSvg();
			const s = stepper([a], [svg], {kind: "native"});
			s.start();
			expect(a.playState).to.equal("running");
			expect(svg.paused).to.equal(false);
			expect(clock.countTimers()).to.equal(0);
			s.stop();
			expect(a.playState, "a script's play() outlasts the CSS pause").to.equal("paused");
			expect(svg.paused).to.equal(true);
		});

		it("1s: one step a second", function () {
			const a = new FakeAnimation();
			const s = stepper([a], [], stepModeFor("1s")!);
			s.start();
			clock.tick(999);
			expect(a.currentTime).to.equal(0);
			clock.tick(1);
			expect(a.currentTime).to.equal(1000);
			s.stop();
		});

		it("sparse: moves on every five minutes, and at once on a start, by all the time since its last step", function () {
			const a = new FakeAnimation();
			const s = stepper([a], [], stepModeFor("sparse")!);
			s.start();
			clock.tick(SPARSE_INTERVAL_MS);
			expect(a.currentTime).to.equal(SPARSE_INTERVAL_MS);
			s.stop();
			clock.tick(30 * 60 * 1000); // half an hour away
			s.start(); // coming back
			expect(a.currentTime, "up to date the moment it is looked at").to.equal(
				SPARSE_INTERVAL_MS + 30 * 60 * 1000
			);
			s.stop();
		});

		it("carries on from where the animations stand after another pace moved them: no jump back", function () {
			const a = new FakeAnimation();
			const s = stepper([a], [], {kind: "native"});
			s.start();
			a.currentTime = 9000; // the browser played it on
			s.setMode(stepModeFor("24")!);
			expect(s.running).to.equal(true);
			expect(a.playState).to.equal("paused");
			clock.tick(1000);
			expect(a.currentTime).to.be.closeTo(10000, 1000 / 24);
			s.stop();
		});
	});

	describe("keeping a cloud's place when the wind changes its loop (keepPhase)", function () {
		const place = (time: number, delay: number, duration: number) =>
			((((time - delay) % duration) + duration) % duration) / duration;

		it("puts the animation at the same place in its loop under the new timing", function () {
			const delay = -170_000;
			const calm = 200_000;
			const windy = calm * 0.4;

			for (const p of [0, 0.25, 0.5, 0.999]) {
				const t = keepPhase(p, delay, windy);
				expect(t, "after the start, where it is drawn").to.be.at.least(0);
				expect(place(t, delay, windy)).to.be.closeTo(p, 1e-9);
			}
		});

		it("lands in the first whole loop after a delay longer than a loop, and in the second for a short one", function () {
			expect(keepPhase(0, -170_000, 80_000)).to.equal(-170_000 + 80_000 * 3);
			expect(keepPhase(0.5, -10_000, 80_000)).to.equal(-10_000 + 80_000 * 1.5);
			expect(keepPhase(0, 0, 80_000)).to.equal(80_000);
		});

		it("rereads every animation's time after something else moved them", function () {
			const a = new FakeAnimation(0);
			const s = stepper([a], []);
			s.start();
			clock.tick(1000);
			a.currentTime = 50_000; // the wind kept its place
			s.reread();
			clock.tick(1000);
			expect(a.currentTime).to.be.closeTo(51_000, 1000 / 24);
			s.stop();
		});
	});

	it("forgets an animation its style cancelled, and undoes a step that got to it before the cancel event", function () {
		const live = new FakeAnimation(0);
		const gone = new FakeAnimation(0);
		const s = stepper([live, gone], []);
		s.start();
		gone.cancelledByStyle(); // reduced motion: animation: none
		clock.tick(1000 / 24); // a step before the event: the write brings it back, held
		expect(gone.playState).to.not.equal("idle");
		gone.fireCancel();
		expect(gone.playState, "cancelled again").to.equal("idle");
		const at = gone.currentTime;
		clock.tick(1000);
		expect(gone.currentTime, "no longer stepped").to.equal(at);
		expect(live.currentTime).to.be.closeTo(1000 + 1000 / 24, 1000 / 24);
		s.stop();
	});
});
