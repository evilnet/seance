import {expect} from "chai";
import {SUN} from "../../../client/js/scenes/ps/markup";
import {FIRE_SIZE, fireDriver, ngSun} from "../../../client/js/scenes/psng/flame";

/** A canvas whose 2D context counts its paints; the timer is a queue the test pumps, its delays kept. */
function rig() {
	let puts = 0;
	const canvas = {
		getContext: () => ({
			createImageData: (w: number, h: number) => ({data: new Uint8ClampedArray(w * h * 4)}),
			putImageData: () => puts++,
		}),
	} as unknown as HTMLCanvasElement;
	const queue = new Map<number, (ms: number) => void>();
	let next = 1;

	const delays: number[] = [];

	const after = (fn: (ms: number) => void, delay: number) => {
		queue.set(next, fn);
		delays.push(delay);
		return next++;
	};

	const cancel = (id: number) => void queue.delete(id);

	/** One 60 Hz frame at `ms`. */
	const pump = (ms: number) => {
		const due = [...queue.values()];
		queue.clear();
		due.forEach((fn) => fn(ms));
	};

	return {driver: fireDriver(canvas, after, cancel), puts: () => puts, queue, pump, delays};
}

describe("psng flame: fireDriver", function () {
	this.timeout(60000);

	it("holds at most one loop of frames (168) after 400 simulated frames", function () {
		const {driver, pump} = rig();
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.start();

		for (let i = 0; i < 400; i++) {
			pump((i * 1000) / 24);
		}

		expect(driver.cachedFrames).to.equal(168);
		driver.destroy();
	});

	it("paints exactly 24 frames in a simulated second of 60 Hz callbacks", function () {
		const {driver, puts, pump} = rig();
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.start();

		for (let i = 0; i < 60; i++) {
			pump((i * 1000) / 60);
		}

		expect(puts()).to.equal(24); // the colours' paint of frame 0, then frames 1..23
		driver.destroy();
	});

	it("wakes once per frame of its own, at the next frame's start, never per screen refresh", function () {
		const {driver, pump, delays} = rig();
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.start();
		pump(1000); // its clock starts here: frame 0
		pump(1010); // a timer 10 ms into frame 0
		expect(delays[0]).to.equal(0);
		expect(delays[1]).to.be.closeTo(1000 / 24, 0.01);
		expect(delays[2]).to.be.closeTo(1000 / 24 - 10, 0.01);
		driver.destroy();
	});

	it("start then stop leaves no pending frame request", function () {
		const {driver, queue, pump} = rig();
		driver.start();
		expect(queue.size).to.equal(1);
		pump(0);
		expect(queue.size).to.equal(1);
		driver.stop();
		expect(queue.size).to.equal(0);
	});

	it("held still (never started) it paints one frame and requests nothing", function () {
		const {driver, puts, queue} = rig();
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.setColours("#ffcf5a", "#ffb23c");
		expect(puts()).to.equal(1);
		expect(queue.size).to.equal(0);
	});

	it("destroy with the loop running leaves no frame request and drops the cache", function () {
		const {driver, queue, pump} = rig();
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.start();
		pump(0);
		pump(100);
		expect(driver.cachedFrames).to.be.greaterThan(0);
		driver.destroy();
		expect(queue.size).to.equal(0);
		expect(driver.cachedFrames).to.equal(0);
	});

	it("a canvas with no 2D context is a driver that does nothing", function () {
		const driver = fireDriver(
			{getContext: () => null} as unknown as HTMLCanvasElement,
			() => 1,
			() => {}
		);
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.start();
		driver.destroy();
	});
});

describe("psng flame: ngSun", function () {
	it("trades the filter group for the canvas between the bloom and the core", function () {
		const out = ngSun(SUN);
		expect(out).to.not.include("ps-s-fire");
		expect(out).to.not.include('<filter id="ps-s-fire"');
		expect(out).to.include(
			`<canvas class="ps-fire" width="${FIRE_SIZE}" height="${FIRE_SIZE}"></canvas>`
		);
		expect(out.indexOf("ps-s-bloom)")).to.be.lessThan(out.indexOf("<canvas"));
		expect(out.indexOf("<canvas")).to.be.lessThan(out.indexOf('r="37"'));
		expect(out.match(/<svg/g)?.length).to.equal(2);
	});
});
