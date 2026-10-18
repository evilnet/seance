import {expect} from "chai";
import {SUN} from "../../../client/js/scenes/ps/markup";
import {FIRE_SIZE, fireDriver, ngSun} from "../../../client/js/scenes/psng/flame";

type Call = [string, ...unknown[]];

/** A 2D context that records its calls (createImageData answers with a real buffer). */
function fakeContext(calls: Call[]) {
	return {
		globalCompositeOperation: "source-over",
		createImageData: (w: number, h: number) => ({data: new Uint8ClampedArray(w * h * 4)}),
		putImageData: (...a: unknown[]) => void calls.push(["putImageData", ...a]),
		drawImage: (...a: unknown[]) => void calls.push(["drawImage", ...a]),
	};
}

/** A canvas whose 2D context counts its paints; the timer is a queue the test pumps, its delays kept.
 * The sprite is a fake from the same factory unless `withSprite` is false (no sprite: the old path). */
function rig(withSprite = true) {
	const main: Call[] = [];
	const spriteCalls: Call[] = [];
	const ctx = fakeContext(main);
	const canvas = {getContext: () => ctx} as unknown as HTMLCanvasElement;
	const spriteCanvas = {
		getContext: () => fakeContext(spriteCalls),
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

	const driver = fireDriver(canvas, after, cancel, () => (withSprite ? spriteCanvas : null));
	/** Paints shown on the main canvas, by either path. */
	const puts = () => main.filter((c) => c[0] === "putImageData" || c[0] === "drawImage").length;
	return {driver, puts, queue, pump, delays, main, ctx, spriteCanvas, spriteCalls};
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

describe("psng flame: the sprite", function () {
	this.timeout(60000);
	const cell = (i: number) => [
		0,
		i * FIRE_SIZE,
		FIRE_SIZE,
		FIRE_SIZE,
		0,
		0,
		FIRE_SIZE,
		FIRE_SIZE,
	];

	it("draws a frame from its sprite cell after the first time, with no putImageData", function () {
		const {driver, pump, main, ctx, spriteCanvas, spriteCalls} = rig();
		driver.setColours("#ffcf5a", "#ffb23c"); // frame 0, first time
		expect(ctx.globalCompositeOperation).to.equal("copy");
		expect(spriteCalls).to.have.length(1);
		expect(spriteCalls[0][0]).to.equal("putImageData");
		expect(spriteCalls[0].slice(2)).to.deep.equal([0, 0]);
		expect(main).to.deep.equal([["drawImage", spriteCanvas, ...cell(0)]]);

		driver.start();
		pump(0);
		pump(1000 / 24 + 1); // frame 1, first time
		expect(spriteCalls.at(-1)?.slice(2)).to.deep.equal([0, FIRE_SIZE]);
		expect(main.at(-1)).to.deep.equal(["drawImage", spriteCanvas, ...cell(1)]);
		const filled = spriteCalls.length;

		for (let i = 2; i <= 168; i++) {
			pump((i * 1000) / 24 + 1);
		}

		expect(driver.spriteFrames).to.equal(168);
		const before = spriteCalls.length;
		pump((169 * 1000) / 24 + 1); // frame 1 of the next loop
		expect(spriteCalls.length).to.equal(before);
		expect(main.at(-1)).to.deep.equal(["drawImage", spriteCanvas, ...cell(1)]);
		expect(filled).to.equal(2);
		expect(main.some((c) => c[0] === "putImageData")).to.equal(false);
		driver.destroy();
	});

	it("a palette change empties the sprite and repaints the current frame in the new colours", function () {
		const {driver, pump, main, spriteCalls} = rig();
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.start();

		for (let i = 0; i < 5; i++) {
			pump((i * 1000) / 24 + 1);
		}

		expect(driver.spriteFrames).to.equal(5);
		const old = new Uint32Array((spriteCalls.at(-1)?.[1] as ImageData).data.slice().buffer);
		const calls = spriteCalls.length;
		driver.setColours("#000000", "#ffffff");
		expect(driver.spriteFrames).to.equal(1);
		expect(spriteCalls.length).to.equal(calls + 1);
		expect(spriteCalls.at(-1)?.slice(2)).to.deep.equal([0, 4 * FIRE_SIZE]);
		const fresh = new Uint32Array((spriteCalls.at(-1)?.[1] as ImageData).data.buffer);
		expect(fresh).to.not.deep.equal(old);
		expect(main.at(-1)?.[3]).to.equal(4 * FIRE_SIZE); // drawn after its cell was refilled
		driver.destroy();
	});

	it("with no sprite it paints by putImageData as before", function () {
		const {driver, pump, main} = rig(false);
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.start();

		for (let i = 0; i < 4; i++) {
			pump((i * 1000) / 24 + 1);
		}

		expect(main.map((c) => c[0])).to.deep.equal([
			"putImageData",
			"putImageData",
			"putImageData",
			"putImageData",
		]);
		expect(driver.spriteFrames).to.equal(0);
		driver.destroy();
	});

	it("destroy drops the sprite", function () {
		const {driver, pump, main} = rig();
		driver.setColours("#ffcf5a", "#ffb23c");
		driver.start();
		pump(0);
		pump(100);
		expect(driver.spriteFrames).to.be.greaterThan(0);
		driver.destroy();
		expect(driver.spriteFrames).to.equal(0);
		const drawn = main.length;
		driver.start();
		pump(1000);
		pump(1100);
		expect(main.length).to.equal(drawn);
		driver.stop();
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
