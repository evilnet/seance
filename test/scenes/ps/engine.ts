import {expect} from "chai";
import {
	CANON_RISE,
	CANON_SET,
	canonical,
	dayOfYear,
	elongation,
	localDayNumber,
	momentAt,
	momentFor,
	moonAt,
	moonPhase,
	rng,
	SEASONS,
	seasonOf,
	sunAt,
	sunTimes,
	WEATHER_ODDS,
	weatherFor,
	WEATHERS,
} from "../../../client/js/scenes/ps/engine";

const epochDays = (iso: string) => Date.parse(iso) / 86400000;

describe("ps engine: the day", function () {
	it("keeps solar noon at 12:30 and gives 45°N its day lengths", function () {
		for (const doy of [1, 80, 172, 266, 355]) {
			const {rise, set} = sunTimes(doy);
			expect((rise + set) / 2).to.be.closeTo(750, 1e-9);
		}

		expect(sunTimes(172).set - sunTimes(172).rise, "midsummer").to.be.closeTo(925.5, 1);
		expect(sunTimes(355).set - sunTimes(355).rise, "midwinter").to.be.closeTo(514.4, 1);
		expect(sunTimes(80).set - sunTimes(80).rise, "equinox").to.be.closeTo(716, 1);
	});

	it("pins the canonical day to the real sunrise and sunset", function () {
		for (const doy of [172, 355]) {
			const {rise, set} = sunTimes(doy);
			expect(canonical(rise, rise, set)).to.be.closeTo(CANON_RISE, 1e-9);
			expect(canonical(set, rise, set)).to.be.closeTo(CANON_SET, 1e-9);
			expect(canonical(rise - 90, rise, set)).to.be.closeTo(300, 1e-9);
			expect(canonical(set + 105, rise, set)).to.be.closeTo(1260, 1e-9);
		}
	});

	it("moves forward through the whole day with no jump, midnight included", function () {
		for (const doy of [172, 355]) {
			const {rise, set} = sunTimes(doy);
			let prev = canonical(0, rise, set);

			for (let m = 0.5; m <= 1440; m += 0.5) {
				const next = canonical(m % 1440, rise, set);
				const step = (next - prev + 1440) % 1440;
				expect(step, `doy ${doy} at ${m}`).to.be.greaterThan(0).and.at.most(1);
				prev = next;
			}
		}
	});

	it("reads the local calendar and clock", function () {
		const d = new Date(2026, 8, 24, 18, 30, 30);
		expect(dayOfYear(d)).to.equal(267);
		expect(dayOfYear(new Date(2026, 0, 1, 0, 5))).to.equal(1);
		expect(localDayNumber(d)).to.equal(Date.UTC(2026, 8, 24) / 86400000);
		expect(momentAt(d).minute).to.be.closeTo(18 * 60 + 30.5, 1e-9);
	});

	it("carries a moment across midnight: the canonical day continues, and the new day draws its own weather", function () {
		const before = momentAt(new Date(2026, 8, 24, 23, 59, 30));
		const after = momentAt(new Date(2026, 8, 25, 0, 0, 30));
		expect(after.dayNumber - before.dayNumber).to.equal(1);
		expect(after.doy - before.doy).to.equal(1);
		const step = (after.canonical - before.canonical + 1440) % 1440;
		expect(step).to.be.greaterThan(0).and.below(3);
		expect(after.weather).to.equal(weatherFor(after.dayNumber, after.season.main));
	});
});

describe("ps engine: the year", function () {
	it("blends seasons with weights that always sum to 1", function () {
		for (let doy = 1; doy <= 366; doy++) {
			const {weights} = seasonOf(doy);
			const sum = SEASONS.reduce((s, k) => s + weights[k], 0);
			expect(sum, `doy ${doy}`).to.be.closeTo(1, 1e-9);
		}
	});

	it("is each season in full on its anchor day, and halfway between anchors", function () {
		expect(seasonOf(32).weights.winter).to.equal(1);
		expect(seasonOf(121).weights.spring).to.equal(1);
		expect(seasonOf(213).weights.summer).to.equal(1);
		expect(seasonOf(305).weights.autumn).to.equal(1);
		const mid = seasonOf(259);
		expect(mid.weights.summer).to.be.closeTo(0.5, 1e-9);
		expect(mid.weights.autumn).to.be.closeTo(0.5, 1e-9);
	});

	it("names the calendar season by the solstices and equinoxes", function () {
		expect(seasonOf(78).main).to.equal("winter");
		expect(seasonOf(79).main).to.equal("spring");
		expect(seasonOf(172).main).to.equal("summer");
		expect(seasonOf(265).main).to.equal("autumn");
		expect(seasonOf(355).main).to.equal("winter");
	});

	it("draws one weather per day, the same every time, at the season's odds", function () {
		expect(weatherFor(20000, "summer")).to.equal(weatherFor(20000, "summer"));

		for (const season of SEASONS) {
			const counts = Object.fromEntries(WEATHERS.map((w) => [w, 0]));
			const N = 40000;

			for (let day = 0; day < N; day++) {
				counts[weatherFor(19000 + day, season)]++;
			}

			let rest = 1;

			for (const [weather, chance] of WEATHER_ODDS[season]) {
				expect(counts[weather] / N, `${season} ${weather}`).to.be.closeTo(chance, 0.015);
				rest -= chance;
			}

			expect(counts.clear / N, `${season} clear`).to.be.closeTo(rest, 0.015);
		}
	});

	it("seeds rng the same way everywhere", function () {
		const a = rng(90210);
		const b = rng(90210);

		for (let i = 0; i < 5; i++) {
			const x = a();
			expect(x).to.equal(b());
			expect(x).to.be.at.least(0).and.below(1);
		}
	});
});

describe("ps engine: the sun and the moon", function () {
	it("rides the sun from the reading start at sunrise, overhead at noon, to the far edge at sunset", function () {
		const {rise, set} = sunTimes(172);
		expect(sunAt(rise, rise, set).x).to.be.closeTo(5, 1e-9);
		expect(sunAt(set, rise, set).x).to.be.closeTo(95, 1e-9);
		const noon = sunAt((rise + set) / 2, rise, set);
		expect(noon.y).to.be.closeTo(10, 1e-9);
		expect(noon.up).to.be.true;
		expect(sunAt(0, rise, set).up).to.be.false;
	});

	it("puts the moon on the night arc and takes it down by day", function () {
		const {rise, set} = sunTimes(266);
		expect(moonAt(0, rise, set).up).to.be.true;
		expect(moonAt(720, rise, set).up).to.be.false;
	});

	it("finds the true full and new moons (true elongation, not the mean month)", function () {
		// Scanned with this very method to the minute; published times are 16:49 and 15:50 UTC.
		expect(elongation(epochDays("2026-09-26T16:52:00Z"))).to.be.closeTo(180, 0.1);
		const e = elongation(epochDays("2026-10-10T16:00:00Z"));
		expect(Math.min(e, 360 - e)).to.be.below(0.1);
	});

	it("lights the moon by (1 − cos D) / 2 and leaves no moon within 9° of new", function () {
		const full = moonPhase(epochDays("2026-09-26T16:52:00Z"));
		expect(full.illumination).to.be.closeTo(1, 0.001);
		expect(full.present).to.be.true;
		const fresh = moonPhase(epochDays("2026-10-10T16:00:00Z"));
		expect(fresh.illumination).to.be.below(0.001);
		expect(fresh.present).to.be.false;
		const waning = moonPhase(epochDays("2026-10-03T00:00:00Z"));
		expect(waning.waning).to.be.true;
	});

	it("builds a whole moment from plain numbers, with the weather overridable", function () {
		const m = momentFor({
			minute: 720,
			doy: 213,
			dayNumber: 20666,
			epochDays: 20666,
			weather: "snow",
		});
		expect(m.weather).to.equal("snow");
		expect(m.season.weights.summer).to.equal(1);
		expect(m.sun.up).to.be.true;
	});
});
