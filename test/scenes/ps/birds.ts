import {expect} from "chai";
import {
	birdsAt,
	dayBirdsMarkup,
	larkSeason,
	passageOf,
	SKEINS,
	skeinsMarkup,
} from "../../../client/js/scenes/ps/birds";
import {mix} from "../../../client/js/scenes/ps/colour";
import {momentFor, sunTimes, type Moment, type Weather} from "../../../client/js/scenes/ps/engine";
import {paletteAt} from "../../../client/js/scenes/ps/palette";

const DAY_MS = 86400000;

/**
 * A moment at a canonical minute of the day (dawn from 300, the day to 1155,
 * dusk to 1260), on a day of the year: the canonical minute is what the
 * mockup's timing reads, and this reaches it exactly.
 */
function at(canon: number, doy: number, weather: Weather = "clear", epochDays = 20000): Moment {
	const {rise, set} = sunTimes(doy);
	const minute =
		canon < 390
			? rise - (390 - canon)
			: canon <= 1155
			? rise + ((canon - 390) / (1155 - 390)) * (set - rise)
			: set + (canon - 1155);
	return momentFor({minute, doy, dayNumber: Math.floor(epochDays), epochDays, weather});
}

/** A real UTC instant, as the engine sees it in UTC: 23:00 on 1 May 2026 is a full moon. */
function utc(iso: string, weather?: Weather): Moment {
	const t = Date.parse(iso);
	const d = new Date(t);
	const doy =
		(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
			Date.UTC(d.getUTCFullYear(), 0, 0)) /
		DAY_MS;
	return momentFor({
		minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
		doy,
		dayNumber: Math.floor(t / DAY_MS),
		epochDays: t / DAY_MS,
		weather,
	});
}

const birds = (m: Moment) => birdsAt(m, paletteAt(m));

describe("ps birds: when they fly (birds.ts, the approved mockup's applyBirds)", function () {
	describe("passageOf: the geese and cranes go north in spring and south in autumn", function () {
		it("ramps the spring passage in from late February and out by mid-May", function () {
			expect(passageOf(51).amount).to.equal(0);
			expect(passageOf(60).amount).to.be.closeTo(0.5, 1e-9);
			expect(passageOf(69).amount).to.equal(1);
			expect(passageOf(115).amount).to.equal(1);
			expect(passageOf(125).amount).to.be.closeTo(0.5, 1e-9);
			expect(passageOf(135).amount).to.equal(0);
		});

		it("ramps the autumn passage in from September and out by late November", function () {
			expect(passageOf(244).amount).to.equal(0);
			expect(passageOf(253.5).amount).to.be.closeTo(0.5, 1e-9);
			expect(passageOf(263).amount).to.equal(1);
			expect(passageOf(309).amount).to.equal(1);
			expect(passageOf(319).amount).to.be.closeTo(0.5, 1e-9);
			expect(passageOf(329).amount).to.equal(0);
		});

		it("calls winter from day 329 to day 50, and flies west from day 190 on", function () {
			expect(passageOf(328).winter).to.equal(false);
			expect(passageOf(329).winter).to.equal(true);
			expect(passageOf(365).winter).to.equal(true);
			expect(passageOf(1).winter).to.equal(true);
			expect(passageOf(50).winter).to.equal(true);
			expect(passageOf(51).winter).to.equal(false);
			expect(passageOf(189).west).to.equal(false);
			expect(passageOf(190).west).to.equal(true);
			expect(passageOf(365).west).to.equal(true);
		});
	});

	describe("the skeins", function () {
		it("flies all three at 23:00 on a clear 1 May, northward", function () {
			// 1 May is day 121: the spring passage is 1 − (121 − 115)/20 = 0.7, over the 0.66 line.
			const b = birds(utc("2026-05-01T23:00:00Z", "clear"));
			expect(b.skeins).to.equal(3);
			expect(b.skeinsOpacity).to.equal(1);
			expect(b.west).to.equal(false);
		});

		it("flies all three southward on a clear 1 November night", function () {
			const b = birds(utc("2026-11-01T23:00:00Z", "clear"));
			expect(b.skeins).to.equal(3);
			expect(b.skeinsOpacity).to.equal(1);
			expect(b.west).to.equal(true);
		});

		it("counts fewer skeins at the passage's edges, never fainter ones", function () {
			const count = (doy: number) => birds(at(1300, doy)).skeins;
			expect(count(57)).to.equal(2); // 6/18 = 0.333…
			expect(count(54)).to.equal(1); // 3/18
			expect(count(52)).to.equal(1); // 1/18, over 0.02
			expect(count(130)).to.equal(1); // 1 − 15/20
			expect(count(213)).to.equal(0); // high summer: none
			expect(birds(at(1300, 57)).skeinsOpacity).to.equal(1);
		});

		it("flies none in rain or a storm (the user, 2026-09-26: birds don't fly in rainstorms), and thins them to one in snow", function () {
			for (const weather of ["rain", "storm"] as const) {
				expect(birds(at(1300, 121, weather)).skeins, weather).to.equal(0);
				expect(birds(at(1300, 121, weather)).skeinsOpacity, weather).to.equal(0);
			}

			expect(birds(at(1300, 121, "snow")).skeins).to.equal(1);
			expect(birds(at(1300, 121, "snow")).skeinsOpacity).to.equal(1);
			expect(birds(at(1300, 121, "wind")).skeins).to.equal(3);
		});

		it("flies none in rain or a storm on a rare winter night either, at any hour of any day", function () {
			for (const weather of ["rain", "storm"] as const) {
				for (let doy = 1; doy <= 365; doy += 4) {
					for (const canon of [150, 250, 320, 1106, 1200, 1300]) {
						const b = birds(at(canon, doy, weather, 20000 + doy));
						expect(
							[b.skeins, b.skeinsOpacity],
							`${weather} day ${doy} ${canon}`
						).to.deep.equal([0, 0]);
					}
				}
			}
		});

		it("flies from canonical 1105, through the night, until canonical 330: never by day", function () {
			const op = (canon: number) => birds(at(canon, 121)).skeinsOpacity;
			expect(op(780)).to.equal(0); // noon
			expect(op(1100)).to.equal(0);
			expect(op(1106)).to.equal(1); // just after 1105, 50 canonical minutes before sunset
			expect(op(1200)).to.equal(1);
			expect(op(320)).to.equal(1); // first light
			expect(op(335)).to.equal(0);
			// The count stands by day too; only the layer is off.
			expect(birds(at(780, 121)).skeins).to.equal(3);
		});

		it("flies 30 minutes before sunset in autumn", function () {
			const {set} = sunTimes(274);
			const m = momentFor({
				minute: set - 30,
				doy: 274,
				dayNumber: 20727,
				epochDays: 20727,
				weather: "clear",
			});
			expect(m.canonical).to.be.at.least(1105);
			expect(birds(m).skeinsOpacity).to.equal(1);
			expect(birds(m).west).to.equal(true);
		});

		it("brings one skein on a rare winter night, seeded by the day: one night in four", function () {
			const night = (dayNumber: number) =>
				birds(
					momentFor({
						minute: 1380,
						doy: 335,
						dayNumber,
						epochDays: dayNumber,
						weather: "clear",
					})
				);
			// rng(20788 × 7919 + 13)() = 0.155, under 0.25; rng(20791 × 7919 + 13)() = 0.465.
			expect(night(20788).skeins).to.equal(1);
			expect(night(20788).skeinsOpacity).to.equal(1);
			expect(night(20791).skeins).to.equal(0);
			expect(night(20791).skeinsOpacity).to.equal(0);
			// Out of winter the rare night does not apply: day 213 is high summer.
			expect(
				birds(
					momentFor({
						minute: 1380,
						doy: 213,
						dayNumber: 20788,
						epochDays: 20788,
						weather: "clear",
					})
				).skeins
			).to.equal(0);
		});

		it("inks them slate by day and near-black from sunset on, the alpha on the whole bird", function () {
			const noon = birds(at(780, 121));
			expect(noon.ink).to.equal("#2c3242");
			expect(noon.wing).to.equal("#2c3242");
			expect(noon.belly).to.equal("#2c3242");
			expect(noon.alpha).to.be.closeTo(0.74, 1e-9);

			// At canonical 1185 the palette's dark is 0.7: past 0.35, so the ink is full night.
			const dusk = at(1185, 121);
			expect(paletteAt(dusk).dark).to.be.closeTo(0.7, 1e-9);
			expect(birds(dusk).alpha).to.be.closeTo(0.88, 1e-9);

			// Canonical 1122 is dark 0.168, about halfway to 0.35: the ink about halfway to near-black.
			const m = at(1122, 121);
			const dark = paletteAt(m).dark;
			const dk = Math.min(1, dark / 0.35);
			expect(birds(m).ink).to.equal(mix("#2c3242", "#15141f", dk));
			expect(birds(m).alpha).to.be.closeTo(0.74 + 0.14 * dk, 1e-9);
		});

		it("catches the full moon's light on the back, the wings and most of all the belly (N2)", function () {
			const m = utc("2026-05-01T23:00:00Z", "clear");
			expect(m.phase.illumination).to.be.greaterThan(0.99);
			expect(m.moon.up && m.phase.present).to.equal(true);
			expect(paletteAt(m).dark).to.equal(1);
			const L = m.phase.illumination;
			const b = birds(m);
			expect(b.ink).to.equal(mix("#15141f", "#b9c4d8", 0.22 * L));
			expect(b.wing).to.equal(mix("#15141f", "#b9c4d8", 0.35 * L));
			expect(b.belly).to.equal(mix("#15141f", "#c6d0e2", 0.5 * L));
			expect(b.ink).to.not.equal("#15141f");
		});

		it("goes dark again under no moon, and when the moon is down", function () {
			const none = utc("2033-04-28T23:00:00Z", "clear");
			expect(none.phase.present).to.equal(false);
			const b = birds(none);
			expect([b.ink, b.wing, b.belly]).to.deep.equal(["#15141f", "#15141f", "#15141f"]);
			expect(b.skeins).to.equal(3);

			const full = utc("2026-05-01T23:00:00Z", "clear");
			const down = birds({...full, moon: {...full.moon, up: false}});
			expect([down.ink, down.wing, down.belly]).to.deep.equal([
				"#15141f",
				"#15141f",
				"#15141f",
			]);
		});

		it("lets the cloud hide the moon's light by the weather's hide", function () {
			// Snow: the one wet weather the skeins still fly in.
			const m = utc("2026-05-01T23:00:00Z", "snow");
			const L = m.phase.illumination * (1 - 0.55);
			expect(birds(m).belly).to.equal(mix("#15141f", "#c6d0e2", 0.5 * L));
		});

		it("holds the moonlight back until the sky is dark: none below 0.45", function () {
			// Canonical 1122 is dark 0.175: the moon lights nothing yet.
			const m = at(1122, 121, "clear", Date.parse("2026-05-01T12:00:00Z") / DAY_MS);
			const b = birds({...m, moon: {...m.moon, up: true}});
			expect(b.ink).to.equal(b.wing);
			expect(b.ink).to.equal(b.belly);
		});
	});

	describe("the steppe's own birds, by day", function () {
		it("circles the buzzard from mid-morning to late afternoon, all year, never in the wet", function () {
			expect(birds(at(780, 121)).buzzard).to.equal(true);
			expect(birds(at(780, 20)).buzzard).to.equal(true); // winter too
			// Thermals cross 0.5 at canonical 510 and 1030.
			expect(birds(at(512, 121)).buzzard).to.equal(true);
			expect(birds(at(508, 121)).buzzard).to.equal(false);
			expect(birds(at(1028, 121)).buzzard).to.equal(true);
			expect(birds(at(1032, 121)).buzzard).to.equal(false);

			for (const weather of ["rain", "snow", "storm"] as const) {
				expect(birds(at(780, 121, weather)).buzzard, weather).to.equal(false);
			}

			for (const weather of ["wind", "heat", "clear"] as const) {
				expect(birds(at(780, 121, weather)).buzzard, weather).to.equal(true);
			}
		});

		it("sings the larks from March to July", function () {
			expect(larkSeason(50)).to.equal(0);
			expect(larkSeason(60)).to.be.closeTo(0.5, 1e-9);
			expect(larkSeason(121)).to.equal(1);
			expect(larkSeason(211.5)).to.be.closeTo(0.5, 1e-9);
			expect(larkSeason(222)).to.equal(0);
		});

		it("raises the larks from first light to the evening, in season and dry", function () {
			expect(birds(at(780, 121)).larks).to.equal(true);
			// Their song crosses 0.5 at canonical 355 and 1085.
			expect(birds(at(357, 121)).larks).to.equal(true);
			expect(birds(at(353, 121)).larks).to.equal(false);
			expect(birds(at(1083, 121)).larks).to.equal(true);
			expect(birds(at(1087, 121)).larks).to.equal(false);
			expect(birds(at(780, 20)).larks).to.equal(false); // January
			expect(birds(at(780, 260)).larks).to.equal(false); // September

			for (const weather of ["rain", "snow", "storm"] as const) {
				expect(birds(at(780, 121, weather)).larks, weather).to.equal(false);
			}

			expect(birds(at(780, 121, "wind")).larks).to.equal(true);
		});

		it("never flies a day bird at night", function () {
			const b = birds(utc("2026-05-01T23:00:00Z", "clear"));
			expect(b.buzzard).to.equal(false);
			expect(b.larks).to.equal(false);
		});

		it("inks the day birds warm dark by day, deeper as it darkens", function () {
			expect(birds(at(780, 121)).dayInk).to.equal("#3a3436");
			expect(birds(utc("2026-05-01T23:00:00Z")).dayInk).to.equal("#1b1a24");
			const m = at(1122, 121);
			expect(birds(m).dayInk).to.equal(
				mix("#3a3436", "#1b1a24", Math.min(1, paletteAt(m).dark / 0.5))
			);
		});
	});
});

/** The inside of every `<div class="${name}"…>…</div>` in `markup`, nested divs included. */
function blocks(markup: string, name: string): string[] {
	const out: string[] = [];
	const open = new RegExp(`<div class="${name}"[^>]*>`, "g");

	for (const m of markup.matchAll(open)) {
		const start = m.index! + m[0].length;
		let depth = 1;

		for (const t of markup.slice(start).matchAll(/<(\/?)div\b[^>]*>/g)) {
			depth += t[1] ? -1 : 1;

			if (depth === 0) {
				out.push(markup.slice(start, start + t.index!));
				break;
			}
		}
	}

	return out;
}

/** Every SMIL element in `markup`. */
const smilIn = (markup: string) =>
	markup.match(/<(animate|animateTransform|animateMotion)\b[^>]*>/g) ?? [];

describe("ps birds: the skeins (skeinsMarkup, the mockup's bird() and three skeins)", function () {
	const markup = skeinsMarkup();
	const flocks = blocks(markup, "ps-flock");

	it("is the same every time: seeded", function () {
		expect(skeinsMarkup()).to.equal(markup);
	});

	it("flies three skeins of 13, 8 and 17 birds: a V of geese, a line of cranes, a small pale far V", function () {
		expect(SKEINS.map((f) => f.n)).to.deep.equal([13, 8, 17]);
		expect(flocks).to.have.length(3);
		expect(flocks.map((f) => f.match(/<span class="ps-bird"/g)?.length)).to.deep.equal([
			13, 8, 17,
		]);
		expect(SKEINS.map((f) => f.kind)).to.deep.equal(["goose", "crane", "goose"]);
	});

	it("numbers the flocks and keeps the mockup's heights, times, scales and opacities", function () {
		const heads = markup.match(/<div class="ps-flock" style="[^"]*">/g) ?? [];
		expect(heads).to.deep.equal([
			'<div class="ps-flock" style="--fi:0;--fy:17%;--fd:42s;--fdl:-8s">',
			'<div class="ps-flock" style="--fi:1;--fy:29%;--fd:52s;--fdl:-30s">',
			'<div class="ps-flock" style="--fi:2;--fy:10%;--fd:64s;--fdl:-47s">',
		]);
		expect(markup.match(/<div class="ps-skein" style="[^"]*">/g)).to.deep.equal([
			'<div class="ps-skein" style="--fs:1;--fo:1">',
			'<div class="ps-skein" style="--fs:0.8;--fo:0.82">',
			'<div class="ps-skein" style="--fs:0.58;--fo:0.55">',
		]);
	});

	it("draws every bird as its own svg, with the goose's and the crane's bodies and the mockup's poses", function () {
		expect(markup.match(/<svg viewBox="0 0 32 20"/g)).to.have.length(38);
		expect(markup).to.include(
			'd="M3.5,11.3 Q6,10.3 9,10.2 Q14,9.6 18.5,10 Q20.5,10.2 22,10.1 L27.4,9.8 Q28.6,9.2 29.6,9.5 L31.2,10.3 L29.4,10.8 Q28.4,11 27.4,11 L22.6,11.4 Q21,12.8 17.5,13 Q12.5,13.3 8.5,12.4 Q6,11.9 3.5,11.3 Z"'
		);
		expect(markup).to.include("M9.5,12.3 L0.4,12.9 L0.5,13.4 L9.6,12.8 Z"); // the crane's legs
		expect(markup).to.include(
			"M16.5,10.1 Q17.2,3.6 8.4,0.3 Q10.6,3.6 10.4,6.4 Q10.4,8.8 11.5,10.4 Z"
		); // up
		expect(markup).to.include(
			"M16.5,10.1 Q17.6,15.6 10.2,19.6 Q11.6,16.6 11.4,14.2 Q11.2,12 11.5,10.4 Z"
		); // down
		expect(markup).to.include(
			"M16.5,10.1 Q16,11.6 6.4,12.2 Q9.2,11.3 10.4,11 Q11.2,10.7 11.5,10.4 Z"
		); // glide
		expect(markup.match(/class="ps-b-far"/g)).to.have.length(38);
		expect(markup.match(/class="ps-b-near"/g)).to.have.length(38);
		expect(markup.match(/class="ps-b-body"/g)).to.have.length(38);
	});

	it("beats every wing through a stroke that loops forever: every SMIL animation repeats indefinitely", function () {
		const smil = smilIn(markup);
		expect(smil).to.have.length(38 * 3); // the lift, and the far and the near wing

		for (const a of smil) {
			expect(a).to.include('repeatCount="indefinite"');
			const keyTimes = /keyTimes="([^"]*)"/.exec(a)![1].split(";").map(Number);
			expect(keyTimes[0]).to.equal(0);
			expect(keyTimes.at(-1)).to.equal(1);
			const values = /values="([^"]*)"/.exec(a)![1].split(";");
			expect(values).to.have.length(keyTimes.length);
		}
	});

	it("sizes the birds in rem and places them in % of their flock, and names nothing in px", function () {
		expect(markup).to.not.match(/\dpx/);
		const spans = markup.match(/<span class="ps-bird" style="[^"]*">/g) ?? [];
		expect(spans).to.have.length(38);

		for (const s of spans) {
			const w = Number(/width:([\d.]+)rem/.exec(s)![1]);
			const h = Number(/height:([\d.]+)rem/.exec(s)![1]);
			// The mockup's 17 × 10.6 px at a scale of 0.94–1.06, at its 16 px rem.
			expect(w).to.be.within((17 * 0.94) / 16 - 1e-3, (17 * 1.06) / 16 + 1e-3);
			expect(h).to.be.within((10.6 * 0.94) / 16 - 1e-3, (10.6 * 1.06) / 16 + 1e-3);
			expect(s).to.match(/left:-?[\d.]+%;top:-?[\d.]+%;/);
			expect(s).to.match(/--wx:-?[\d.]+rem;--wy:-?[\d.]+rem;--wd:[\d.]+s;--wdl:-?[\d.]+s/);
		}
	});

	it("paints the bodies two-tone from one gradient, ps-b-belly, in a 0 × 0 svg: the back in the ink, the belly lit", function () {
		const ids = [...markup.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
		expect(ids).to.deep.equal(["ps-b-belly"]);
		expect(markup.startsWith('<svg class="ps-bird-defs" width="0" height="0"')).to.equal(true);
		expect(markup).to.include('<stop offset=".3" style="stop-color: var(--ps-bird-ink)"/>');
		expect(markup).to.include('<stop offset="1" style="stop-color: var(--ps-bird-belly)"/>');
	});
});

describe("ps birds: the steppe's own (dayBirdsMarkup: the buzzard circling, the larks rising)", function () {
	const markup = dayBirdsMarkup();

	it("is the same every time: seeded", function () {
		expect(dayBirdsMarkup()).to.equal(markup);
	});

	it("holds one buzzard and three larks, and no kestrel or swallows (the user's pick)", function () {
		expect(markup.match(/<div class="ps-buzzard">/g)).to.have.length(1);
		expect(markup.match(/<div class="ps-lark" /g)).to.have.length(3);
		expect(markup).to.not.include("kestrel");
		expect(markup).to.not.include("swallow");
	});

	it("circles the buzzard on its squashed loop once every 26 s, beating its wings now and then", function () {
		const buzzard = blocks(markup, "ps-buzzard")[0];
		expect(buzzard).to.include('<svg viewBox="-65 -35 130 70" aria-hidden="true">');
		expect(buzzard).to.include('<g transform="scale(1 .5)">');
		expect(buzzard).to.match(
			/<animateMotion dur="26s" begin="-4s" repeatCount="indefinite" rotate="auto" path="M44,0 C44,26 24,46 -2,46 /
		);
		expect(buzzard).to.include(
			'attributeName="transform" type="scale" dur="52.000s" begin="-9.00s"'
		);
		expect(buzzard).to.include('values="1 1;1 .62;1 .88;1 .62;1 .88;1 .66;1 1;1 1"');
	});

	it("puts the larks at 30, 47 and 66 % across on their own 66, 72 and 78 s song flights", function () {
		expect(markup.match(/<div class="ps-lark" style="[^"]*">/g)).to.deep.equal([
			'<div class="ps-lark" style="left:30%;--ld:66s;--ldl:-3s">',
			'<div class="ps-lark" style="left:47%;--ld:72s;--ldl:-31s">',
			'<div class="ps-lark" style="left:66%;--ld:78s;--ldl:-55s">',
		]);

		for (const lark of blocks(markup, "ps-lark")) {
			for (const set of ["ps-lark-fl", "ps-lark-ch", "ps-lark-cl"]) {
				expect(lark, set).to.include(`<g class="${set}">`);
			}

			expect(lark).to.include('<svg viewBox="0 0 20 14" aria-hidden="true">');
		}
	});

	it("loops every SMIL animation forever, and names nothing in px and no id", function () {
		const smil = smilIn(markup);
		expect(smil).to.have.length(1 + 1 + 3 * 2); // the circle, the flap, each lark's two flutters

		for (const a of smil) {
			expect(a).to.include('repeatCount="indefinite"');
		}

		expect(markup).to.not.match(/\dpx/);
		expect(markup).to.not.match(/\bid="/);
	});
});
