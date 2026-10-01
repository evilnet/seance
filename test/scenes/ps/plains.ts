import {expect} from "chai";
import {
	clouds,
	DECK_BAND,
	DECK_HEIGHT,
	FIREFLIES,
	RAIN_DECK_HEIGHT,
	fireflies,
	GRASS_EDGE_LOWEST,
	LAND_SHARE,
	landSvg,
	nearGrass,
	smoke,
	weatherClouds,
	weatherLayers,
	yurtSvg,
} from "../../../client/js/scenes/ps/plains";
import {WEATHERS} from "../../../client/js/scenes/ps/engine";

/** How many times `class="<name>"` appears: the whole attribute, so `ps-l-mount` is not `ps-l-mount2`. */
const classCount = (markup: string, name: string) => markup.split(`class="${name}"`).length - 1;

describe("ps plains: the land, the near grass, the yurt, its smoke and the fireflies (plains.ts)", function () {
	describe("landSvg", function () {
		const land = landSvg();

		it("is the same drawing every time: the generators are seeded", function () {
			expect(landSvg()).to.equal(land);
		});

		it("is one svg on the mockup's 1200 × 400 viewBox, stretched to the box", function () {
			expect(land.startsWith('<svg class="ps-land" viewBox="0 0 1200 400"')).to.equal(true);
			expect(land).to.include('preserveAspectRatio="none"');
			expect(land.trim().endsWith("</svg>")).to.equal(true);
			expect(land.match(/<svg\b/g)).to.have.length(1);
		});

		it("gives GRASS_EDGE_LOWEST from the grass band it draws: its edge's lowest point, on the land's share of the scene", function () {
			const d = /class="ps-l-grass" d="([^"]*)"/.exec(land)?.[1] ?? "";
			const edge = d.slice(0, d.indexOf(" L1200,400"));
			const ys = [...edge.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
			// A cubic Bézier stays inside its control points' hull, so the largest y bounds the
			// edge from below; the edge starts on it (M0,300), so the edge reaches it.
			const lowest = Math.max(...ys);
			expect(lowest).to.equal(300);
			expect(edge.startsWith(`M0,${lowest} `)).to.equal(true);
			expect(GRASS_EDGE_LOWEST).to.equal(1 - LAND_SHARE + (LAND_SHARE * lowest) / 400);
		});

		it("names one id, the river's sky: the heat haze is the weather layer's, on hot days only", function () {
			const ids = [...land.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
			expect(ids).to.deep.equal(["ps-river-sky"]);
			expect(land).to.not.include("<filter");
			expect(land).to.not.include("ps-heat");
		});

		it("draws the eight land paths, once each", function () {
			for (const name of [
				"ps-l-mount2",
				"ps-l-mount",
				"ps-l-far",
				"ps-l-riverbed",
				"ps-l-river",
				"ps-l-hill2",
				"ps-l-hill1",
				"ps-l-grass",
			]) {
				expect(classCount(land, name), name).to.equal(1);
				expect(land, name).to.include(`<path class="${name}" d="`);
			}
		});

		it("in the mockup's order, back to front", function () {
			const at = (name: string) => land.indexOf(`class="${name}"`);
			const order = [
				"ps-l-mount2",
				"ps-l-mount",
				"ps-l-far",
				"ps-l-shrub",
				"ps-l-riverbed",
				"ps-l-bedstone",
				"ps-l-river",
				"ps-l-river-hi",
				"ps-l-hill2",
				"ps-l-rim",
				"ps-l-tuft2",
				"ps-l-tree",
				"ps-l-hill1",
				"ps-l-grass",
			].map(at);
			expect(order.every((i) => i >= 0)).to.equal(true);
			expect([...order].sort((a, b) => a - b)).to.deep.equal(order);
		});

		it("rims each hill with a line, and fills the river with the sky", function () {
			expect(classCount(land, "ps-l-rim")).to.equal(2);
			expect(classCount(land, "ps-l-river-hi")).to.equal(1);
			expect(land).to.include('<linearGradient id="ps-river-sky"');
			// An attribute, as the sun's and moon's gradients are: a fragment
			// url in an external stylesheet is the one place engines have
			// disagreed about which document it names.
			expect(land).to.match(
				/<path class="ps-l-river" d="[^"]*" fill="url\(#ps-river-sky\)"\/>/
			);
			expect(land).to.include("var(--ps-river-sky-top)");
			expect(land).to.include("var(--ps-river-sky-bottom)");
		});

		it("scatters 40 shrubs, 160 far tufts and 240 near tufts, a quarter or so of them lit", function () {
			expect(classCount(land, "ps-l-shrub")).to.equal(40);
			expect(classCount(land, "ps-l-tuft2")).to.equal(160);
			const lit = classCount(land, "ps-l-tuft-lit");
			expect(classCount(land, "ps-l-tuft1") + lit).to.equal(240);
			expect(lit).to.be.within(30, 90);
		});

		it("stands four trees with two trunks, and seven stones in the riverbed", function () {
			expect(classCount(land, "ps-l-tree")).to.equal(4);
			expect(classCount(land, "ps-l-trunk")).to.equal(2);
			const bed = land.match(/<g class="ps-l-bedstone">([\s\S]*?)<\/g>/)?.[1] ?? "";
			expect(bed.match(/<ellipse /g)).to.have.length(7);
		});

		it("puts every shrub on the far plain and every tuft on its own hill", function () {
			for (const m of land.matchAll(/class="ps-l-shrub" cx="([\d.]+)" cy="([\d.]+)"/g)) {
				expect(Number(m[1])).to.be.within(0, 1200);
				expect(Number(m[2])).to.be.within(130, 140);
			}

			const foot = (name: string) =>
				[
					...land.matchAll(new RegExp(`class="${name}" d="M(-?[\\d.]+),([\\d.]+) `, "g")),
				].map((m) => Number(m[2]));
			expect(foot("ps-l-tuft2").every((y) => y >= 200 && y <= 240)).to.equal(true);
			expect(
				[...foot("ps-l-tuft1"), ...foot("ps-l-tuft-lit")].every((y) => y >= 250 && y <= 294)
			).to.equal(true);
		});

		it("holds no text and no style strings but the gradient's stops", function () {
			expect(land).to.not.match(/<text\b/);
			expect(land.match(/style="/g)).to.have.length(2);
		});
	});

	describe("nearGrass", function () {
		const grass = nearGrass();

		it("is the same drawing every time", function () {
			expect(nearGrass()).to.equal(grass);
		});

		it("is one svg on the mockup's 1200 × 120 viewBox, anchored to the foot and sliced", function () {
			expect(grass.startsWith('<svg class="ps-blades" viewBox="0 0 1200 120"')).to.equal(
				true
			);
			expect(grass).to.include('preserveAspectRatio="xMidYMax slice"');
			expect(grass.match(/<svg\b/g)).to.have.length(1);
		});

		it("holds one swaying blade path, rooted along the whole width", function () {
			const sway = grass.match(/<g class="ps-sway">(<path d="([^"]*)"\/>)<\/g>/);
			expect(sway, "one path inside the swaying group").to.not.equal(null);
			expect(grass.match(/<path\b/g)).to.have.length(1);
			const blades = sway![2].split("Z").filter((s) => s.trim());
			expect(blades.length).to.be.within(200, 300);
			expect(blades.every((b) => /,120 Q/.test(b))).to.equal(true);
		});

		it("scatters 50 flowers in the mockup's five colours", function () {
			const flowers = [
				...grass.matchAll(
					/<circle cx="(\d+)" cy="(\d+)" r="([\d.]+)" fill="(#[0-9a-f]{6})"\/>/g
				),
			];
			expect(flowers).to.have.length(50);
			expect(grass.match(/<circle\b/g)).to.have.length(50);

			for (const [, cx, cy, r, fill] of flowers) {
				expect(Number(cx)).to.be.within(0, 1200);
				expect(Number(cy)).to.be.within(70, 114);
				expect(Number(r)).to.be.within(1.4, 2.8);
				expect(["#f3c85a", "#f6f0e4", "#e79a7a", "#c9b0e6", "#f2a65a"]).to.include(fill);
			}
		});

		it("names no ids", function () {
			expect(grass).to.not.match(/\bid="/);
		});
	});

	describe("yurtSvg", function () {
		const yurt = yurtSvg();

		it("is the same drawing every time", function () {
			expect(yurtSvg()).to.equal(yurt);
		});

		it("is one svg on the mockup's 240 × 170 viewBox", function () {
			expect(yurt.startsWith('<svg viewBox="0 0 240 170" aria-hidden="true">')).to.equal(
				true
			);
			expect(yurt.trim().endsWith("</svg>")).to.equal(true);
			expect(yurt.match(/<svg\b/g)).to.have.length(1);
		});

		it("names only ps-y- ids, and every url(#…) it uses is one of them", function () {
			const ids = [...yurt.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
			expect(ids).to.have.members([
				"ps-y-wall",
				"ps-y-roof",
				"ps-y-inner",
				"ps-y-pool",
				"ps-y-crown-glow",
				"ps-y-blur",
				"ps-y-soft",
			]);

			for (const id of ids) {
				expect(id).to.match(/^ps-y-/);
			}

			const used = [...yurt.matchAll(/url\(#([^)]*)\)/g)].map((m) => m[1]);
			expect(used.length).to.be.at.least(8);

			for (const id of used) {
				expect(ids, id).to.include(id);
			}
		});

		it("names its parts with ps-y- classes, the mockup's own", function () {
			for (const name of [
				"ps-y-felt-l",
				"ps-y-felt-c",
				"ps-y-roof-t",
				"ps-y-roof-b",
				"ps-y-pool",
				"ps-y-wood",
				"ps-y-stone",
				"ps-y-lit",
				"ps-y-rope",
				"ps-y-band",
				"ps-y-band-mark",
				"ps-y-roof",
				"ps-y-snow",
				"ps-y-rib",
				"ps-y-crown",
				"ps-y-pipe",
				"ps-y-door",
				"ps-y-door-orn",
			]) {
				expect(yurt, name).to.include(`class="${name}"`);
			}

			for (const [, cls] of yurt.matchAll(/class="([^"]*)"/g)) {
				expect(cls).to.match(/^ps-y-[a-z-]+$/);
			}

			// No worn path to the door: by day it read as a hard beam (the user, 2026-09-25).
			expect(yurt).to.not.include("ps-y-path");
		});

		it("paints its patterned band with 16 marks along the band's curve", function () {
			const band = yurt.match(/<g class="ps-y-band-mark">([\s\S]*?)<\/g>/)?.[1] ?? "";
			const marks = [
				...band.matchAll(/<path d="M([\d.]+),([\d.]+) l3,-2\.4 l3,2\.4 l-3,2\.4 Z"\/>/g),
			];
			expect(marks).to.have.length(16);
			expect(band.match(/<path /g)).to.have.length(16);

			marks.forEach((m, i) => {
				const x = 44 + i * 10.2;
				expect(Number(m[1])).to.be.closeTo(x, 0.01);
				expect(Number(m[2])).to.be.closeTo(
					101.5 - Math.sin(((x - 38) / 164) * Math.PI) * 4,
					0.01
				);
			});
		});

		it("lights the wall, the crown, the door and its seams, and snows on the roof", function () {
			expect(classCount(yurt, "ps-y-lit")).to.equal(4);
			expect(classCount(yurt, "ps-y-pool")).to.equal(1);
			expect(classCount(yurt, "ps-y-snow")).to.equal(1);
			expect(classCount(yurt, "ps-y-pipe")).to.equal(2);
		});

		it("lays a soft pool of light on the ground at the door at night, and no cone down the path (the user's pick, 2026-09-25)", function () {
			expect(yurt).to.not.include("ps-y-spill");
			const pool =
				'<ellipse class="ps-y-pool" cx="120" cy="157" rx="58" ry="15" fill="url(#ps-y-pool)" filter="url(#ps-y-soft)"/>';
			expect(yurt).to.include(pool);
			expect(yurt).to.include(
				'<radialGradient id="ps-y-pool" cx=".5" cy=".42" r=".58"><stop offset="0" stop-color="#ffc47a" stop-opacity=".78"/><stop offset=".55" stop-color="#ffb060" stop-opacity=".3"/><stop offset="1" stop-color="#ffb060" stop-opacity="0"/></radialGradient>'
			);
			expect(yurt).to.include(
				'<filter id="ps-y-soft" x="-80%" y="-120%" width="260%" height="340%"><feGaussianBlur stdDeviation="5"/></filter>'
			);
			// Over the yurt's shadow, under the stones it lights and the woodpile.
			const at = (s: string) => yurt.indexOf(s);
			expect(at(pool)).to.be.greaterThan(at('fill="#000" opacity=".16"'));
			expect(at(pool)).to.be.lessThan(at('class="ps-y-wood"'));
			expect(at(pool)).to.be.lessThan(at('class="ps-y-stone"'));
		});

		it("holds no text and no style strings", function () {
			expect(yurt).to.not.match(/<text\b/);
			expect(yurt).to.not.include("style=");
		});
	});

	describe("smoke", function () {
		const puffs = smoke();

		it("rises in five puffs, the mockup's", function () {
			expect(puffs.match(/<i /g)).to.have.length(5);
			expect(smoke()).to.equal(puffs);
		});

		it("gives each its own rise and delay, sized in rem, never px", function () {
			expect(puffs).to.not.include("px");
			const got = [
				...puffs.matchAll(
					/<i style="--sd:([\d.]+)s;--sdl:([\d.]+)s;width:([\d.]+)rem;height:([\d.]+)rem"><\/i>/g
				),
			].map((m) => m.slice(1).map(Number));
			expect(got).to.deep.equal([
				[6.2, 0, 9 / 16, 9 / 16],
				[7.1, 1.5, 11 / 16, 11 / 16],
				[6.6, 3, 8 / 16, 8 / 16],
				[7.6, 4.4, 12 / 16, 12 / 16],
				[6.9, 5.6, 9 / 16, 9 / 16],
			]);
		});
	});

	describe("fireflies", function () {
		it("makes as many as asked: 34 for the window, 17 on a phone", function () {
			expect(FIREFLIES).to.equal(34);
			expect(fireflies(34).match(/<i /g)).to.have.length(34);
			expect(fireflies(FIREFLIES / 2).match(/<i /g)).to.have.length(17);
		});

		it("is seeded: the phone's 17 are the first 17 of the window's 34", function () {
			expect(fireflies(34)).to.equal(fireflies(34));
			expect(fireflies(34).startsWith(fireflies(17))).to.equal(true);
		});

		it("places each in the field and drifts it in rem, never px", function () {
			const flies = fireflies(34);
			expect(flies).to.not.include("px");

			for (const m of flies.matchAll(
				/<i style="left:([\d.]+)%;top:([\d.]+)%;--d:([\d.]+)s;--dl:(-?[\d.]+)s;--dx:(-?[\d.]+)rem;--dy:(-?[\d.]+)rem;--b:([\d.]+)s;--bl:(-?[\d.]+)s"><\/i>/g
			)) {
				const [, left, top, d, , dx, dy, b] = m.map(Number);
				expect(left).to.be.within(0, 100);
				expect(top).to.be.within(0, 100);
				expect(d).to.be.within(5, 11);
				expect(Math.abs(dx)).to.be.at.most(30 / 16);
				expect(Math.abs(dy)).to.be.at.most(13 / 16);
				expect(b).to.be.within(2.6, 5.8);
			}

			expect([
				...flies.matchAll(
					/<i style="left:[\d.]+%;top:[\d.]+%;--d:[\d.]+s;--dl:-?[\d.]+s;--dx:-?[\d.]+rem;--dy:-?[\d.]+rem;--b:[\d.]+s;--bl:-?[\d.]+s"><\/i>/g
				),
			]).to.have.length(34);
		});
	});

	describe("clouds", function () {
		const sky = clouds();

		it("is the same drawing every time", function () {
			expect(clouds()).to.equal(sky);
		});

		it("draws the mockup's five clouds, each of five blobs", function () {
			expect(classCount(sky, "ps-cloud")).to.equal(5);
			expect(sky.match(/<div\b/g)).to.have.length(5);
			expect(sky.match(/<i /g)).to.have.length(25);
		});

		it("sizes each in cqw from the mockup's px at its 1180 px window, with its own height, speed and delay", function () {
			const got = [
				...sky.matchAll(
					/<div class="ps-cloud" style="--cw:([\d.]+)cqw;--cy:(\d+)%;--cd:(\d+)s;--cdl:(-\d+)s;/g
				),
			].map((m) => m.slice(1).map(Number));
			const MOCKUP = [
				[170, 9, 230, -40],
				[104, 21, 280, -160],
				[210, 30, 320, -100],
				[80, 14, 200, -70],
				[130, 24, 260, -215],
			];
			expect(got).to.have.length(5);

			got.forEach(([cw, cy, cd, cdl], i) => {
				const [w, y, d, dl] = MOCKUP[i];
				expect(cw, `cloud ${i}`).to.be.closeTo(w / 11.8, 0.005);
				expect([cy, cd, cdl], `cloud ${i}`).to.deep.equal([y, d, dl]);
			});
		});

		it("gives each a rest place for reduced motion, --cp: where its delay puts it in its loop, five places across the sky", function () {
			const got = [
				...sky.matchAll(
					/--cw:([\d.]+)cqw;--cy:\d+%;--cd:(\d+)s;--cdl:(-\d+)s;--cp:([\d.]+)">/g
				),
			].map((m) => m.slice(1).map(Number));
			expect(got).to.have.length(5);
			// Where ps.css's frozen drift stands each at the mockup's 1180 × 700
			// window, 16 px rem: its left edge from −(width + 4 px) at 0 to
			// 1180 + 4 px at 1.
			const W = 1180;
			const lefts = got.map(([cw, cd, cdl, cp], i) => {
				expect(cp, `cloud ${i}`).to.be.closeTo(-cdl / cd, 0.00005);
				expect(cp, `cloud ${i}`).to.be.within(0, 1);
				const width = (cw / 100) * W;
				const left = (W + width + 8) * cp - width - 4;
				expect(left + width, `cloud ${i} on the sky, at least partly`).to.be.above(0);
				expect(left, `cloud ${i} on the sky, at least partly`).to.be.below(W);
				return left;
			});
			const apart = [...lefts].sort((a, b) => a - b);

			for (let i = 1; i < apart.length; i++) {
				expect(apart[i] - apart[i - 1], "no two clouds at one place").to.be.above(W / 20);
			}
		});

		it("keeps every blob inside its cloud's box, so a cloud one width off the edge is out of sight", function () {
			const blobs = [
				...sky.matchAll(
					/<i style="left:([\d.]+)%;top:[\d.]+%;width:([\d.]+)%;height:[\d.]+%"><\/i>/g
				),
			].map((m) => m.slice(1).map(Number));
			expect(blobs).to.have.length(25);
			blobs.forEach(([left, width], i) => {
				expect(left, `blob ${i}`).to.be.at.least(0);
				expect(left + width, `blob ${i}`).to.be.at.most(100);
			});
		});

		it("places each blob in % of its own cloud, the mockup's five, never px", function () {
			expect(sky).to.not.include("px");
			const first = sky.slice(0, sky.indexOf("</div>"));
			const blobs = [
				...first.matchAll(
					/<i style="left:([\d.]+)%;top:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%"><\/i>/g
				),
			].map((m) => m.slice(1).map(Number));
			expect(blobs).to.deep.equal([
				[0, 45, 55, 55],
				[18, 12, 44, 80],
				[45, 20, 40, 72],
				[64, 42, 36, 56],
				[28, 50, 50, 50],
			]);
			expect(
				sky.match(/<i style="left:[\d.]+%;top:[\d.]+%;width:[\d.]+%;height:[\d.]+%"><\/i>/g)
			).to.have.length(25);
		});

		it("names no ids and holds no text", function () {
			expect(sky).to.not.match(/\bid="/);
			expect(sky.replace(/<[^>]*>/g, "")).to.equal("");
		});
	});

	describe("weatherClouds: rain and storms are cloudier (the user, 2026-09-26)", function () {
		const rain = weatherClouds("rain");
		const storm = weatherClouds("storm");
		/** A cloud's own attributes, as clouds() writes them: width (cqw), top (%), drift, delay, rest. */
		const CLOUD =
			/<div class="ps-cloud" style="--cw:([\d.]+)cqw;--cy:(\d+)%;--cd:(\d+)s;--cdl:(-\d+)s;--cp:([\d.]+)">/g;
		const cloudsOf = (markup: string) =>
			[...markup.matchAll(CLOUD)].map((m) => m.slice(1).map(Number));
		/** A deck's markup, from its opening tag to the end of its billows: the storm's, or rain's lighter one. */
		const deckOf = (markup: string, cls = "ps-deck") =>
			new RegExp(`<div class="${cls}">(.*?)</div>`).exec(markup)?.[1];
		/** The markup after the deck: the rain's four. */
		const afterDeck = (markup: string) => markup.slice(markup.indexOf("</div>") + 6);

		it("is the same drawing every time", function () {
			for (const weather of WEATHERS) {
				expect(weatherClouds(weather), weather).to.equal(weatherClouds(weather));
			}
		});

		it("adds nothing in any other weather: the clear day's five stand alone", function () {
			for (const weather of WEATHERS.filter((w) => w !== "rain" && w !== "storm")) {
				expect(weatherClouds(weather), weather).to.equal("");
			}
		});

		it('adds four more clouds in rain, each of the five blobs, in front of a lighter deck (the user: "yes to the rain deck")', function () {
			expect(classCount(rain, "ps-cloud")).to.equal(4);
			expect(cloudsOf(rain)).to.have.length(4);
			expect(classCount(rain, "ps-deck ps-deck-rain")).to.equal(1);
			expect(rain.startsWith('<div class="ps-deck ps-deck-rain">')).to.equal(true);
			const four = afterDeck(rain);
			expect(four.match(/<i /g)).to.have.length(20);
			// The same blobs as the five, in % of their own cloud.
			const five = clouds().slice(0, clouds().indexOf("</div>"));
			const blobs = (markup: string) => markup.slice(markup.indexOf("<i "));
			expect(blobs(four.slice(0, four.indexOf("</div>")))).to.equal(blobs(five));
		});

		it("makes the four bigger than any of the five, sitting at 5 to 25 % of the height", function () {
			const five = cloudsOf(clouds());
			const biggest = Math.max(...five.map(([cw]) => cw));

			for (const [cw, cy] of cloudsOf(rain)) {
				expect(cw, "wider than the five").to.be.above(biggest);
				expect(cy).to.be.within(5, 25);
			}
		});

		it("gives each of the four a rest place for reduced motion: nine places across the sky with the five", function () {
			// As the five's test: ps.css's frozen drift at the mockup's 1180 ×
			// 700 window stands a cloud's left edge from −(width + 4 px) at 0 to
			// 1180 + 4 px at 1.
			const W = 1180;
			const lefts = [...cloudsOf(clouds()), ...cloudsOf(rain)].map(
				([cw, , cd, cdl, cp], i) => {
					expect(cp, `cloud ${i}`).to.be.closeTo(-cdl / cd, 0.00005);
					expect(cp, `cloud ${i}`).to.be.within(0, 1);
					const width = (cw / 100) * W;
					const left = (W + width + 8) * cp - width - 4;
					expect(left + width, `cloud ${i} on the sky, at least partly`).to.be.above(0);
					expect(left, `cloud ${i} on the sky, at least partly`).to.be.below(W);
					return left;
				}
			);
			expect(lefts).to.have.length(9);
			const apart = [...lefts].sort((a, b) => a - b);

			for (let i = 1; i < apart.length; i++) {
				expect(apart[i] - apart[i - 1], "no two clouds at one place").to.be.above(W / 20);
			}
		});

		it("drifts the four as slowly as the five or slower: heavy cloud", function () {
			const slowest = Math.min(...cloudsOf(clouds()).map(([, , cd]) => cd));

			for (const [, , cd] of cloudsOf(rain)) {
				expect(cd).to.be.at.least(slowest);
			}
		});

		it("lays a low overcast deck across the top of the sky on a stormy day, behind the rain's four", function () {
			expect(classCount(storm, "ps-deck")).to.equal(1);
			expect(storm.startsWith('<div class="ps-deck">')).to.equal(true);
			expect(afterDeck(storm)).to.equal(afterDeck(rain));
		});

		it("gives rain a lighter deck than a storm's: a shallower band, and shallower billows along the same edge", function () {
			expect(RAIN_DECK_HEIGHT).to.be.within(18, 26);
			expect(RAIN_DECK_HEIGHT).to.be.below(DECK_HEIGHT);
			const heights = (markup: string) =>
				[...markup.matchAll(/height:([\d.]+)cqw/g)].map((m) => Number(m[1]));
			const rainDeck = heights(deckOf(rain, "ps-deck ps-deck-rain") ?? "");
			const stormDeck = heights(deckOf(storm) ?? "");
			expect(rainDeck).to.have.length(stormDeck.length);
			rainDeck.forEach((h, i) => expect(h, `billow ${i}`).to.be.below(stormDeck[i]));
		});

		for (const [weather, cls, deckHeight] of [
			["storm", "ps-deck", DECK_HEIGHT],
			["rain", "ps-deck ps-deck-rain", RAIN_DECK_HEIGHT],
		] as const) {
			describe(`the ${weather} deck's billows: wide at every window's shape, and the band's edge closed`, function () {
				const markup = weatherClouds(weather);
				/**
				 * Each billow as the markup writes it: left and width in % of the
				 * deck (whose width is the scene's, so a % of it is a cqw), and its
				 * top and height tied to its width, in cqw: top = the band's edge
				 * less half the height.
				 */
				const billows = [
					...(deckOf(markup, cls) ?? "").matchAll(
						/<i style="left:(-?[\d.]+)%;top:calc\(([\d.]+)% - ([\d.]+)cqw\);width:([\d.]+)%;height:([\d.]+)cqw"><\/i>/g
					),
				].map((m) => {
					const [left, edge, lift, width, height] = m.slice(1).map(Number);
					return {left, edge, lift, width, height};
				});

				/** A billow's box in px on a window W × H: the deck is deckHeight % of the height. */
				const boxOn = (b: typeof billows[number], W: number, H: number) => {
					const deck = (deckHeight / 100) * H;
					const width = (b.width / 100) * W;
					const height = (b.height / 100) * W;
					const top = (b.edge / 100) * deck - (b.lift / 100) * W;
					return {
						width,
						height,
						top,
						centre: top + height / 2,
						bottom: top + height,
						deck,
					};
				};

				const WINDOWS: Array<[string, number, number]> = [
					["a portrait phone", 390, 844],
					["the mockup's window", 1180, 700],
					["a 16:9 desktop", 1280, 720],
					["a tall tablet", 834, 1194],
				];

				it("draws only billows, at least six", function () {
					expect(billows.length).to.be.at.least(6);
					expect(
						(deckOf(markup, cls) ?? "").replace(/<i style="[^"]*"><\/i>/g, "")
					).to.equal("");
				});

				it("centres every billow on the band's lower edge (ps.css paints the band over the deck's top DECK_BAND %)", function () {
					for (const b of billows) {
						expect(b.edge).to.equal(DECK_BAND);
						expect(b.lift * 2, "half its height above the edge").to.equal(b.height);
					}
				});

				it("ties each billow's height to its width: wider than tall on every window, a portrait phone's too", function () {
					// Sized in % of the deck on both axes, a billow was about 78 ×
					// 143 px on a 390 × 844 phone: a tall drip, not a wide ellipse.
					for (const [name, W, H] of WINDOWS) {
						for (const b of billows) {
							const box = boxOn(b, W, H);
							expect(
								box.width / box.height,
								`${name}: ${box.width} × ${box.height}`
							).to.be.within(1.6, 3);
						}
					}
				});

				it("closes the band's edge all the way across: at the edge each billow is its full width, and each overlaps the next", function () {
					// The centre is on the edge on every window, so the chord there
					// is the billow's whole width, whatever the window's shape.
					const spans = billows
						.map((b) => [b.left, b.left + b.width])
						.sort((a, c) => a[0] - c[0]);
					let reach = 0;

					for (const [from, to] of spans) {
						expect(
							from,
							`a gap in the band's edge at ${reach.toFixed(1)} %`
						).to.be.below(reach - 2);
						reach = Math.max(reach, to);
					}

					expect(reach, "to the deck's right edge").to.be.above(100);
				});

				it("hangs each billow below the band and within the deck on the mockup's window, a 16:9 desktop and a phone", function () {
					for (const [name, W, H] of WINDOWS) {
						for (const b of billows) {
							const box = boxOn(b, W, H);
							expect(box.centre, name).to.be.closeTo(
								(DECK_BAND / 100) * box.deck,
								1e-9
							);
							expect(box.bottom, `${name}: within the deck`).to.be.at.most(box.deck);
						}
					}
				});
			});
		}

		it("names no ids, holds no text and no px", function () {
			for (const markup of [rain, storm]) {
				expect(markup).to.not.match(/\bid="/);
				expect(markup).to.not.include("px");
				expect(markup.replace(/<[^>]*>/g, "")).to.equal("");
			}
		});
	});

	describe("weatherLayers", function () {
		/** The `<i>` inside `<div class="${layer}">…</div>`, or 0 when there is no such layer. */
		const count = (markup: string, layer: string) => {
			const m = new RegExp(`<div class="${layer}">([\\s\\S]*?)</div>`).exec(markup);
			return m ? m[1].split("<i ").length - 1 : 0;
		};

		const drops = (markup: string) => count(markup, "ps-rain");
		const flakes = (markup: string) => count(markup, "ps-snow");
		const seeds = (markup: string) => count(markup, "ps-seeds");
		const flash = (markup: string) => classCount(markup, "ps-flash");
		const band = (markup: string) => classCount(markup, "ps-heatband");
		const haze = (markup: string) => markup.split('id="ps-heat"').length - 1;

		it("builds nothing on a clear day: no drops, flakes or seeds, no flash, no heat", function () {
			for (const phone of [false, true]) {
				const clear = weatherLayers("clear", phone);
				expect(clear).to.equal("");
				expect([drops(clear), flakes(clear), seeds(clear)]).to.deep.equal([0, 0, 0]);
			}
		});

		it("rains 130 drops, 65 on a phone, with the rain's wind's seeds and nothing else", function () {
			const rain = weatherLayers("rain", false);
			expect(drops(rain)).to.equal(130);
			expect(drops(weatherLayers("rain", true))).to.equal(65);
			expect(seeds(rain)).to.equal(26);
			expect([flakes(rain), flash(rain), band(rain), haze(rain)]).to.deep.equal([0, 0, 0, 0]);
			expect(rain.match(/<i /g)).to.have.length(130 + 26);
		});

		it("storms: the rain's drops, the wind's seeds and the lightning", function () {
			const storm = weatherLayers("storm", false);
			expect(drops(storm)).to.equal(130);
			expect(seeds(storm)).to.equal(26);
			expect(flash(storm)).to.equal(1);
			const phone = weatherLayers("storm", true);
			expect(drops(phone)).to.equal(65);
			expect(seeds(phone)).to.equal(13);
			expect(flash(phone)).to.equal(1);
			expect([flakes(storm), band(storm), haze(storm)]).to.deep.equal([0, 0, 0]);
		});

		it("snows 120 flakes, 60 on a phone, with the snow's wind's seeds", function () {
			const snow = weatherLayers("snow", false);
			expect(flakes(snow)).to.equal(120);
			expect(flakes(weatherLayers("snow", true))).to.equal(60);
			expect(seeds(snow)).to.equal(26);
			expect([drops(snow), flash(snow), band(snow), haze(snow)]).to.deep.equal([0, 0, 0, 0]);
		});

		it("blows 26 seeds on a windy day, 13 on a phone, and nothing else", function () {
			const wind = weatherLayers("wind", false);
			expect(seeds(wind)).to.equal(26);
			expect(seeds(weatherLayers("wind", true))).to.equal(13);
			expect([drops(wind), flakes(wind), flash(wind), band(wind), haze(wind)]).to.deep.equal([
				0, 0, 0, 0, 0,
			]);
		});

		it("builds the seeds whenever the weather has wind (the mockup's; their level is --ps-wind-op), never on a still day", function () {
			// rain .3, storm .6, wind 1, snow .15; clear and heat are still.
			const WINDY = {clear: 0, rain: 26, storm: 26, wind: 26, snow: 26, heat: 0};

			for (const weather of WEATHERS) {
				expect(seeds(weatherLayers(weather, false)), weather).to.equal(WINDY[weather]);
				expect(seeds(weatherLayers(weather, true)), `${weather} on a phone`).to.equal(
					WINDY[weather] / 2
				);
			}
		});

		it("puts the seeds first, behind the rain and the snow, as the mockup's layers are", function () {
			for (const weather of ["rain", "storm", "snow"] as const) {
				const markup = weatherLayers(weather, false);
				expect(markup.startsWith('<div class="ps-seeds">'), weather).to.equal(true);
			}
		});

		it("on a hot day holds the heat band and the haze, and no particles", function () {
			for (const phone of [false, true]) {
				const heat = weatherLayers("heat", phone);
				expect(band(heat)).to.equal(1);
				expect(haze(heat)).to.equal(1);
				expect(heat).to.not.include("<i ");
				expect(flash(heat)).to.equal(0);
			}
		});

		it("keeps the heat haze's final values (a 0.007 × 0.05 turbulence, displacement 2, 9 s)", function () {
			const heat = weatherLayers("heat", false);
			expect(heat).to.include(
				'<filter id="ps-heat" x="0" y="-5%" width="100%" height="110%"'
			);
			expect(heat).to.include('baseFrequency="0.007 0.05"');
			expect(heat).to.include('values="0.007 0.05;0.009 0.038;0.007 0.05"');
			expect(heat).to.include('scale="2"');
			expect(heat).to.include('dur="9s"');
		});

		it("hosts the haze in its own empty svg, never display: none (a filter there may not resolve)", function () {
			const svg = /<svg class="ps-heat-haze"[^>]*>/.exec(weatherLayers("heat", false))?.[0];
			expect(svg, "the haze's svg").to.not.equal(undefined);
			expect(svg).to.include('width="0"');
			expect(svg).to.include('height="0"');
			expect(svg).to.include('aria-hidden="true"');
			expect(weatherLayers("heat", false)).to.not.include("display");
		});

		it("builds the haze on hot days only", function () {
			for (const weather of WEATHERS) {
				for (const phone of [false, true]) {
					expect(haze(weatherLayers(weather, phone)), weather).to.equal(
						weather === "heat" ? 1 : 0
					);
				}
			}
		});

		it("is seeded: the same every time, and a phone's particles are the first half of the window's", function () {
			/** The `<i>` of one kind's layer, in order. */
			const dots = (markup: string, layer: string) =>
				new RegExp(`<div class="${layer}">([\\s\\S]*?)</div>`)
					.exec(markup)?.[1]
					.match(/<i [^>]*><\/i>/g) ?? [];

			for (const weather of ["rain", "storm", "snow", "wind"] as const) {
				expect(weatherLayers(weather, false), weather).to.equal(
					weatherLayers(weather, false)
				);

				for (const layer of ["ps-rain", "ps-snow", "ps-seeds"]) {
					const all = dots(weatherLayers(weather, false), layer);
					const half = dots(weatherLayers(weather, true), layer);
					expect(half, `${weather} ${layer}`).to.deep.equal(all.slice(0, all.length / 2));
				}
			}
		});

		it("moves nothing in px: the marks' sizes in rem, their travel in cqw/cqh", function () {
			for (const weather of WEATHERS) {
				expect(weatherLayers(weather, false), weather).to.not.match(/\dpx/);
			}

			const rain = [
				...weatherLayers("rain", false).matchAll(
					/<i style="left:([\d.]+)%;--rd:([\d.]+)s;--rdl:(-?[\d.]+)s;opacity:([\d.]+)"><\/i>/g
				),
			];
			expect(rain).to.have.length(130);

			for (const [, left, rd, rdl, opacity] of rain.map((m) => m.map(Number))) {
				expect(left).to.be.within(0, 110);
				expect(rd).to.be.within(0.55, 0.9);
				expect(rdl).to.be.within(-1.2, 0);
				expect(opacity).to.be.within(0.4, 1);
			}

			const snow = [
				...weatherLayers("snow", false).matchAll(
					/<i style="left:([\d.]+)%;--fs:([\d.]+)rem;--fd:([\d.]+)s;--fdl:(-?[\d.]+)s;--fx:(-?[\d.]+)cqw;opacity:([\d.]+)"><\/i>/g
				),
			];
			expect(snow).to.have.length(120);

			for (const [, left, fs, fd, fdl, fx, opacity] of snow.map((m) => m.map(Number))) {
				expect(left).to.be.within(0, 105);
				expect(fs).to.be.within(2 / 16, 5.4 / 16);
				expect(fd).to.be.within(7, 14);
				expect(fdl).to.be.within(-14, 0);
				expect(fx).to.be.within(-50 / 11.8 - 0.01, 30 / 11.8 + 0.01);
				expect(opacity).to.be.within(0.5, 1);
			}

			const wind = [
				...weatherLayers("wind", false).matchAll(
					/<i style="--y:(\d+)%;--sd:([\d.]+)s;--sdl:(-?[\d.]+)s;--sy:(-?[\d.]+)cqh"><\/i>/g
				),
			];
			expect(wind).to.have.length(26);

			for (const [, y, sd, sdl, sy] of wind.map((m) => m.map(Number))) {
				expect(y).to.be.within(0, 100);
				expect(sd).to.be.within(3.5, 6.5);
				expect(sdl).to.be.within(-6, 0);
				expect(sy).to.be.within(-30 / 7 - 0.01, 30 / 7 + 0.01);
			}
		});

		it("names only ps- ids and holds no text", function () {
			for (const weather of WEATHERS) {
				const markup = weatherLayers(weather, false);

				for (const m of markup.matchAll(/\bid="([^"]*)"/g)) {
					expect(m[1]).to.match(/^ps-/);
				}

				expect(markup.replace(/<[^>]*>/g, ""), weather).to.equal("");
			}
		});
	});
});
