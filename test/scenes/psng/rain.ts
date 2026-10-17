import {expect} from "chai";
import {rain} from "../../../client/js/scenes/ps/plains";
import {RAIN_TILE_SECONDS, rainTiles} from "../../../client/js/scenes/psng/rain";

// NG's rain (psng/rain.ts): classic's drops on three sheets of two viewport-sized tiles each.

type Viewport = {width: number; height: number};

/** A length from an inline style in px: %, cqw/cqh of the scene (the viewport), or px. */
function px(value: string, axis: "width" | "height", vp: Viewport): number {
	const n = parseFloat(value);

	if (value.endsWith("%")) {
		return (n / 100) * vp[axis];
	}

	if (value.endsWith("cqw")) {
		return (n / 100) * vp.width;
	}

	if (value.endsWith("cqh")) {
		return (n / 100) * vp.height;
	}

	if (value.endsWith("px")) {
		return n;
	}

	throw new Error(`unknown length ${value}`);
}

const styleOf = (tag: string) =>
	Object.fromEntries(
		[...(/style="([^"]*)"/.exec(tag)?.[1] ?? "").split(";")]
			.filter(Boolean)
			.map((d) => d.split(":").map((s) => s.trim()) as [string, string])
	);

/** The sheets, each with its tiles' opening tags and the drops' markup inside each tile. */
function parse(markup: string) {
	const sheets = [
		...markup.matchAll(/<div class="psng-rain-sheet"[^>]*>((?:<div[^>]*>.*?<\/div>)+)<\/div>/g),
	];
	return sheets.map((s) =>
		[...s[1].matchAll(/(<div class="psng-rain-tile"[^>]*>)(.*?)<\/div>/g)].map((t) => ({
			tag: t[1],
			drops: t[2],
		}))
	);
}

const lefts = (markup: string) =>
	[...markup.matchAll(/<i style="left:([\d.]+)%/g)].map((m) => m[1]).sort();

for (const [count, vp] of [
	[130, {width: 1512, height: 900}],
	[65, {width: 932, height: 430}],
] as const) {
	describe(`ps NG rain: rainTiles(${count}, ${vp.width}×${vp.height})`, function () {
		const markup = rainTiles(count, vp);
		const sheets = parse(markup);

		it("three sheets at classic's speed (perf-band's periods ×100/118), two tiles each, the twins alike", function () {
			expect(RAIN_TILE_SECONDS).to.deep.equal([0.52, 0.62, 0.71]);
			expect(sheets).to.have.length(3);
			const speeds = [
				...markup.matchAll(/<div class="psng-rain-sheet" style="--rd:([\d.]+)s"/g),
			];
			expect(speeds.map((m) => Number(m[1]))).to.deep.equal(RAIN_TILE_SECONDS);

			for (const tiles of sheets) {
				expect(tiles).to.have.length(2);
				expect(tiles[0].drops).to.equal(tiles[1].drops);
			}
		});

		it(`${count} drops in total, at rain(${count})'s horizontal places`, function () {
			const once = sheets.map((tiles) => tiles[0].drops).join("");
			expect(once.match(/<i /g)).to.have.length(count);
			expect(lefts(once)).to.deep.equal(lefts(rain(count)));
		});

		it("every animated element (each tile) is at most the viewport, and the twin sits one tile up", function () {
			for (const tiles of sheets) {
				for (const {tag} of tiles) {
					const s = styleOf(tag);
					expect(px(s.width, "width", vp)).to.be.at.most(vp.width);
					expect(px(s.height, "height", vp)).to.be.at.most(vp.height);
					expect(px(s.height, "height", vp)).to.equal(vp.height);
				}

				expect(styleOf(tiles[0].tag).top).to.equal("0");
				expect(px(styleOf(tiles[1].tag).top, "height", vp)).to.equal(-vp.height);
			}
		});

		it("no SMIL, no animation of its own markup", function () {
			expect(markup).to.not.match(/<animate|<set|animation/);
		});
	});
}
