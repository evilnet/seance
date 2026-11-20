import {expect} from "chai";
import {
	FLAME_LAYERS,
	FLAME_POSES,
	FLAME_SPACE,
	flamePoses,
	flameSvg,
} from "../../../client/js/scenes/ps/flames";

// The stove's fire (docs/projects/ps-yurt.md §16, as built 2026-11-21: "soft firelight, flowing"): three
// layers of flame shapes, each a loop of poses that fade into one another.

/** Every number in a path, as [x, y] pairs. */
const pairs = (d: string): Array<[number, number]> => {
	const v = [...d.matchAll(/-?[0-9.]+/g)].map((m) => Number(m[0]));
	const out: Array<[number, number]> = [];

	for (let i = 0; i + 1 < v.length; i += 2) {
		out.push([v[i], v[i + 1]]);
	}

	return out;
};

describe("ps yurt: the stove's flames (flames.ts, docs/projects/ps-yurt.md §16)", function () {
	it("draws three layers, red outside to white-hot within, each blurred less than the one outside it", function () {
		expect(FLAME_LAYERS.map((l) => l.name)).to.deep.equal(["outer", "mid", "inner"]);
		expect(FLAME_LAYERS[0].blur).to.be.above(FLAME_LAYERS[1].blur);
		expect(FLAME_LAYERS[1].blur).to.be.above(FLAME_LAYERS[2].blur);
	});

	for (const layer of FLAME_LAYERS) {
		describe(`the ${layer.name} layer`, function () {
			const poses = flamePoses(layer);

			it(`has ${FLAME_POSES} poses, the same on every call, each closed and inside the flame space with the blur's margin`, function () {
				expect(poses.length).to.equal(FLAME_POSES);
				expect(flamePoses(layer)).to.deep.equal(poses);

				for (const d of poses) {
					expect(d).to.match(/^M/).and.match(/Z$/);

					for (const [x, y] of pairs(d)) {
						expect(x).to.be.within(-8, FLAME_SPACE.width + 8);
						expect(y).to.be.within(0, FLAME_SPACE.height + 4);
					}
				}
			});

			it("flows: each pose looks more like the next than like the pose across the loop (the user, 2026-11-21: the first try was choppy)", function () {
				// The silhouette's top across the width, in ten columns of the flame space.
				const profile = (d: string) => {
					const cols: number[] = Array<number>(10).fill(FLAME_SPACE.height);

					for (const [x, y] of pairs(d)) {
						const c = Math.floor(x / (FLAME_SPACE.width / 10));

						if (c >= 0 && c < 10) {
							cols[c] = Math.min(cols[c], y);
						}
					}

					return cols;
				};
				const dist = (a: number[], b: number[]) =>
					a.reduce((t, v, i) => t + Math.abs(v - b[i]), 0) / a.length;
				const pr = poses.map(profile);
				let next = 0;
				let across = 0;

				for (let i = 0; i < pr.length; i++) {
					next += dist(pr[i], pr[(i + 1) % pr.length]);
					across += dist(pr[i], pr[(i + pr.length / 2) % pr.length]);
				}

				expect(next, "it moves").to.be.above(0);
				// Poses drawn independently score about 1 (median 0.97); the approved loop 0.59 to 0.69.
				expect(next / across).to.be.below(0.75);
			});

			it("draws each pose in its own blurred svg, filled with the layer's gradient, its ids its own", function () {
				const svg = flameSvg(layer, 0, "ps-yt-test");
				expect(svg).to.match(
					/^<svg viewBox="0 0 60 54" preserveAspectRatio="none" aria-hidden="true">/
				);
				expect(svg).to.contain(`<feGaussianBlur stdDeviation="${layer.blur}"/>`);
				expect(svg)
					.to.contain('fill="url(#ps-yt-test-g)"')
					.and.contain('filter="url(#ps-yt-test-b)"');
				layer.stops.forEach(([, colour]) =>
					expect(svg).to.contain(`stop-color="${colour}"`)
				);
				expect(svg).to.not.match(/fill="#/);
			});
		});
	}
});
