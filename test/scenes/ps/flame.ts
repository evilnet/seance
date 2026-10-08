import {expect} from "chai";
import {
	createFire,
	createTurbulence,
	fireColours,
	fireField,
	frequencyAt,
	FIRE,
	FIRE_FPS,
	type FireCanvas,
} from "../../../client/js/scenes/ps/flame";

const SIZE = 32;

function fakeCanvas(): FireCanvas & {commits: number} {
	return {
		size: SIZE,
		pixels: new Uint32Array(SIZE * SIZE),
		commits: 0,
		commit() {
			this.commits++;
		},
	};
}

describe("ps scene: the sun's fire", function () {
	describe("frequencyAt", function () {
		it("walks the SMIL values evenly over the loop and comes back", function () {
			expect(frequencyAt(0)).to.deep.equal([0.034, 0.052]);
			const third = frequencyAt(FIRE.loop / 3);
			expect(third[0]).to.be.closeTo(0.046, 1e-9);
			expect(third[1]).to.be.closeTo(0.036, 1e-9);
			const half = frequencyAt(FIRE.loop / 6);
			expect(half[0]).to.be.closeTo(0.04, 1e-9);
			expect(half[1]).to.be.closeTo(0.044, 1e-9);
			expect(frequencyAt(FIRE.loop + 1)).to.deep.equal(frequencyAt(1));
			expect(frequencyAt(-1)).to.deep.equal(frequencyAt(FIRE.loop - 1));
		});
	});

	describe("the turbulence", function () {
		it("is the same for the same seed, and another for another", function () {
			const a = createTurbulence(7);
			const b = createTurbulence(7);
			const c = createTurbulence(8);
			const at = (t: ReturnType<typeof createTurbulence>) =>
				t.fractal(0, 12.5, -40.25, 0.034, 0.052, 3);
			expect(at(a)).to.equal(at(b));
			expect(at(a)).to.not.equal(at(c));
		});

		it("is zero on the lattice, as Perlin noise is", function () {
			const t = createTurbulence(7);
			expect(t.noise2(0, 3, 5)).to.equal(0);
			expect(t.noise2(1, -2, 0)).to.equal(0);
		});

		it("stays within the fractal sum's bounds", function () {
			const t = createTurbulence(FIRE.seed);

			for (let i = 0; i < 500; i++) {
				const v = t.fractal(i % 2, i * 1.7 - 400, i * 0.9 - 200, 0.034, 0.052, 3);
				expect(Math.abs(v)).to.be.below(1.75);
			}
		});
	});

	describe("a frame", function () {
		const field = fireField(createTurbulence(FIRE.seed), ...frequencyAt(0), 64);
		const at = (x: number, y: number) => field[y * 64 + x];

		it("samples near the gradient's centre in the middle and past its rim at the corners", function () {
			expect(at(32, 32)).to.be.below(80);
			expect(at(0, 0)).to.equal(255);
			expect(at(63, 63)).to.equal(255);
		});

		it("bends the disc's edge: the rim is not a circle", function () {
			// Where the field crosses the rim along each axis from the centre.
			const reach = (dx: number, dy: number) => {
				let x = 32;
				let y = 32;

				while (at(x, y) < 200) {
					x += dx;
					y += dy;
				}

				return Math.abs(x - 32) + Math.abs(y - 32);
			};

			const reaches = [reach(1, 0), reach(-1, 0), reach(0, 1), reach(0, -1)];
			expect(Math.max(...reaches) - Math.min(...reaches)).to.be.at.least(1);
		});
	});

	describe("the colours", function () {
		it("are the flame opaque at the centre, 0.8 at 0.6, and the edge transparent at the rim", function () {
			const lut = fireColours("#ff0000", "#0000ff");
			const rgba = (w: number) => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24];
			expect(rgba(lut[0])).to.deep.equal([255, 0, 0, 255]);
			expect(rgba(lut[153])).to.deep.equal([255, 0, 0, 204]);
			expect(rgba(lut[255])).to.deep.equal([0, 0, 255, 0]);
			const [r, g, b, a] = rgba(lut[204]); // 0.8: halfway from 0.6 to the rim
			expect(r).to.be.closeTo(128, 1);
			expect([g, b, a]).to.deep.equal([0, 128, 102]);
		});
	});

	describe("the clock", function () {
		it("paints nothing until it has colours, then the frame for its time", function () {
			const canvas = fakeCanvas();
			const fire = createFire(canvas, {frame: () => () => {}});
			fire.setCurrentTime(0);
			expect(canvas.commits).to.equal(0);
			fire.setColours("#ffcf5a", "#ffb23c");
			expect(canvas.commits).to.equal(1);
			expect(canvas.pixels[0] >>> 24).to.equal(0); // a corner: past the rim
		});

		it("computes each frame of the loop once and paints only when the frame changes", function () {
			const canvas = fakeCanvas();
			const fire = createFire(canvas, {frame: () => () => {}});
			fire.setColours("#ffcf5a", "#ffb23c");
			fire.setCurrentTime(0.01); // still frame 0
			expect(canvas.commits).to.equal(1);
			fire.setCurrentTime(1 / FIRE_FPS);
			expect(canvas.commits).to.equal(2);
			expect(fire.cachedFrames).to.equal(2);
			fire.setCurrentTime(FIRE.loop + 1 / FIRE_FPS); // a loop on: frame 1 again, from the cache
			expect(fire.cachedFrames).to.equal(2);
			fire.setColours("#ffcf5a", "#ffb23c"); // the same colours: nothing to do
			expect(canvas.commits).to.equal(2);
			fire.setColours("#ff6e2c", "#ff5424"); // the hour's new colours repaint the frame
			expect(canvas.commits).to.equal(3);
		});

		it("plays on its own under native playback and stops when paused", function () {
			const canvas = fakeCanvas();
			let next: ((ms: number) => void) | null = null;
			let cancelled = 0;
			const fire = createFire(canvas, {
				frame(fn) {
					next = fn;

					return () => {
						cancelled++;
						next = null;
					};
				},
			});
			fire.setColours("#ffcf5a", "#ffb23c");
			fire.setCurrentTime(2);
			expect(fire.animationsPaused()).to.equal(true);
			fire.unpauseAnimations();
			expect(fire.animationsPaused()).to.equal(false);
			next!(10000); // the first frame keeps the time it stood at
			expect(fire.getCurrentTime()).to.equal(2);
			next!(10500);
			expect(fire.getCurrentTime()).to.be.closeTo(2.5, 1e-9);
			fire.pauseAnimations();
			expect(fire.animationsPaused()).to.equal(true);
			expect(cancelled).to.equal(1);
		});
	});
});
