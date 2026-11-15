import {expect} from "chai";
import {WEATHERS} from "../../../client/js/scenes/ps/engine";
import {
	ROOM_PIECES,
	roomMarkup,
	WINDOW_CLIPS,
	windowMotion,
	windowWeather,
} from "../../../client/js/scenes/ps/room";

describe("ps yurt: the room's markup (room.ts, docs/projects/ps-yurt.md §5)", function () {
	const markup = roomMarkup();

	it("is one static svg in the design frame, covering the scene around the stove", function () {
		expect(
			markup.startsWith(
				'<div class="ps-indoor"><svg class="ps-yt" viewBox="-320 0 1920 800" preserveAspectRatio="xMidYMid slice"'
			)
		).to.equal(true);
		expect(roomMarkup()).to.equal(markup); // deterministic
	});

	it("has no SMIL, prefixes every id, and defines every clip it uses", function () {
		expect(markup).to.not.match(/<(animate|animateMotion|animateTransform|set)\b/);
		const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
		expect(new Set(ids).size).to.equal(ids.length);
		ids.forEach((id) => expect(id).to.match(/^ps-yt-/));

		for (const ref of markup.matchAll(/url\(#([^)]+)\)/g)) {
			expect(ids).to.include(ref[1]);
		}

		[...WINDOW_CLIPS, "ps-yt-crown"].forEach((id) => expect(ids).to.include(id));
	});

	it("draws every piece, and colours the room by class or variable only", function () {
		ROOM_PIECES.forEach((p) => expect(markup, p).to.contain(p));
		const literal = [...markup.matchAll(/<[^>]*fill="#[^"]+"[^>]*>/g)].map((m) => m[0]);
		literal.forEach((tag) => expect(tag, tag).to.contain("ps-yt-lit"));
	});

	it("is a stack of layers in the design frame, in order (plan 2, task 2)", function () {
		const at = (s: string) => markup.indexOf(s);
		const order = [
			'<div class="ps-indoor"><svg class="ps-yt" viewBox="-320 0 1920 800" preserveAspectRatio="xMidYMid slice"',
			'<div class="ps-ym-panes" data-weather="">',
			'<svg class="ps-yt ps-yt-front" viewBox="-320 0 1920 800"',
			'<div class="ps-ym-fireglow"><svg class="ps-yt" viewBox="-320 0 1920 800"',
			'<svg class="ps-yt ps-yt-glow" viewBox="-320 0 1920 800"',
			'<svg class="ps-yt ps-yt-over" viewBox="-320 0 1920 800"',
			'<div class="ps-ym-top">',
		].map(at);
		expect(order[0]).to.equal(0);
		order.slice(1).forEach((i, k) => expect(i, `layer ${k + 1}`).to.be.above(order[k]));
		expect(markup.endsWith("</div></div>")).to.equal(true);
		expect(markup).to.not.contain("mix-blend-mode");
	});

	it("sees the views out, their weather and the crown's sky behind the panes; the frames, the ribs and all that stands in front; the glows above them", function () {
		const panes = markup.indexOf('class="ps-ym-panes"');
		const glow = markup.indexOf('class="ps-ym-fireglow"');
		expect(markup.indexOf('class="ps-yt-weather"')).to.be.below(panes);
		[
			"ps-yt-p-window-back",
			"ps-yt-p-window-left",
			"ps-yt-p-window-right",
			"ps-yt-ribs",
			"ps-yt-p-stove",
			"ps-yt-p-table",
		].forEach((c) => expect(markup.indexOf(c), c).to.be.above(panes).and.below(glow));
		expect(markup.indexOf('class="ps-yt-glow-fire"')).to.be.above(glow);
		// The front's holes are a clip, not a mask: a mask re-rasters the whole svg off the pixel grid
		// at a fractional scale (plan 2, task 2's ruling).
		expect(markup.split('clip-path="url(#ps-yt-openings)"').length - 1).to.equal(1);
		expect(markup).to.not.contain('<mask id="ps-yt-openings"');
	});

	it("lets the fire and the lamp light what stands in the room, the stove dark against its own glow (§6)", function () {
		const glows = markup.indexOf('class="ps-yt-glow-fire"');
		expect(glows).to.be.above(0);
		ROOM_PIECES.forEach((p) => expect(markup.indexOf(p), p).to.be.below(glows));
		const over = markup.indexOf('class="ps-yt-stove-over"');
		expect(over).to.be.above(glows);
		expect(markup.indexOf("url(#ps-yt-fire)")).to.be.above(over);
	});

	it("lets the sun through the crown fall over the stove and its pipe, drawn twice or not", function () {
		const over = markup.indexOf('class="ps-yt-stove-over"');
		expect(markup.indexOf('class="ps-yt-beam"')).to.be.above(over);
	});

	it("draws the fire, the lamp's flame and the steam over the over layer (plan 2, task 4)", function () {
		const topAt = markup.indexOf('<div class="ps-ym-top">');
		const top = markup.slice(topAt);
		const over = markup.slice(markup.indexOf('<svg class="ps-yt ps-yt-over"'), topAt);
		expect(top).to.match(/^<div class="ps-ym-top"><div class="ps-ym-fire" style="--x:[^"]+">/);
		const still = (/<g class="ps-yt-still-hearth ps-yt-burn">(.*?)<\/g>/.exec(over) ?? [
			"",
			"",
		])[1];
		expect(still, "plan 1's still fire").to.contain("url(#ps-yt-fire)");
		expect(top).to.match(
			/<div class="ps-ym-lamp" style="--x:[^"]+"><div class="ps-ym-flame"><svg /
		);
		expect(top.split('class="ps-ym-flame"').length - 1).to.equal(1);
		const steam = (/<div class="ps-ym-steam" style="[^"]+">(.*?)<\/div>/.exec(top) ?? [
			"",
			"",
		])[1];
		expect(steam.split("<i ").length - 1).to.equal(3);
		expect(
			markup.split("ps-yt-still-hearth").length - 1,
			"the fire and the lamp's flame"
		).to.equal(2);
		expect(markup.split("ps-yt-still-steam").length - 1, "both drawings of the stove").to.equal(
			2
		);
	});

	it("draws the stove's flames to dance: three tongues, a core and four sparks, clipped to the door (§16)", function () {
		const top = markup.slice(markup.indexOf('<div class="ps-ym-top">'));
		const style = (/<div class="ps-ym-fire" style="([^"]+)">/.exec(top) ?? ["", ""])[1];
		const clip = (/clip-path:polygon\(([^)]*)\)/.exec(style) ?? ["", ""])[1];
		const points = clip.split(",").map((p) => p.trim().split(/\s+/));
		expect(points.length, "the door's outline").to.be.at.least(16);

		for (const p of points) {
			expect(p.length).to.equal(2);
			p.forEach((v) => {
				expect(v).to.match(/^[0-9.]+%$/);
				expect(parseFloat(v), "inside the box").to.be.within(0, 100);
			});
		}

		const flames = top.slice(
			top.indexOf('<div class="ps-ym-flames">'),
			top.indexOf('<div class="ps-ym-steam"')
		);
		expect(top).to.match(/<div class="ps-ym-fire" style="[^"]+"><div class="ps-ym-flames">/);
		const count = (c: string) => flames.split(c).length - 1;
		expect(count('class="ps-ym-tongue '), "tongues").to.equal(3);
		expect(count('class="ps-ym-core"'), "core").to.equal(1);
		expect(count('class="ps-ym-spark"'), "sparks").to.equal(4);
		["ps-ym-t1", "ps-ym-t2", "ps-ym-t3"].forEach((t) => expect(count(`${t}"`), t).to.equal(1));
		expect(markup).to.not.contain("ps-ym-fire-body");
		expect(markup).to.not.contain("ps-ym-fire-tongues");

		const box = (t: string) => {
			const m = new RegExp(`class="ps-ym-tongue ${t}" style="([^"]+)"`).exec(flames);
			const get = (k: string) =>
				parseFloat((new RegExp(`${k}:([0-9.]+)%`).exec(m?.[1] ?? "") ?? ["", "NaN"])[1]);
			return {bottom: get("bottom"), height: get("height")};
		};
		const [t1, t2, t3] = ["ps-ym-t1", "ps-ym-t2", "ps-ym-t3"].map(box);
		expect(t2.height, "the middle tongue the tallest").to.be.above(
			Math.max(t1.height, t3.height)
		);
		// The coal bed's top curves round the stove, so the feet differ by a hair.
		[t1, t3].forEach((t) =>
			expect(t.bottom, "their feet on the coals").to.be.closeTo(t2.bottom, 2)
		);
		expect(flames).to.match(/<svg viewBox="0 0 20 40" preserveAspectRatio="none">/);

		for (const m of flames.matchAll(/class="ps-ym-spark" style="([^"]+)"/g)) {
			expect(m[1]).to.match(/--sd:[0-9.]+s;--sdl:-?[0-9.]+s/);
		}
	});

	it("draws the coal bed under the fire, and fades the still fire and steam with the burn (plan 3)", function () {
		const over = markup.slice(
			markup.indexOf('<svg class="ps-yt ps-yt-over"'),
			markup.indexOf('<div class="ps-ym-top">')
		);
		const embers = over.indexOf('class="ps-yt-embers"');
		expect(embers).to.be.above(0);
		const bed = over.slice(embers, over.indexOf("</g>", embers));
		expect(bed.indexOf('fill="#120d10"'), "a dark firebox behind the coals (§16)").to.be.above(
			0
		);
		expect(bed.indexOf('fill="#120d10"')).to.be.below(bed.indexOf('fill="#3a1610"'));
		expect(embers).to.be.below(over.indexOf('class="ps-yt-still-hearth ps-yt-burn"'));
		expect(
			markup.split("ps-yt-still-steam ps-yt-burn").length - 1,
			"both stove drawings"
		).to.equal(2);
	});

	it("keeps the plains' classes out of the room", function () {
		expect(markup).to.not.match(/class="[^"]*\bps-(moon|sun|stars|weather|frost)\b/);
		expect(markup).to.contain("ps-m-ell").and.contain("ps-m-shape");
	});

	it("stays a reasonable size", function () {
		expect(markup.length).to.be.below(350_000);
	});

	describe("the windows' weather (docs/projects/ps-yurt.md §7)", function () {
		for (const w of WEATHERS) {
			it(`shows ${w} in the windows, the same on every call`, function () {
				const s = windowWeather(w, false);
				expect(s).to.contain(`data-weather="${w}"`);
				expect(windowWeather(w, false)).to.equal(s);
				expect(s).to.not.match(/<(animate|set)\b/);
			});
		}

		it("draws each weather's own marks", function () {
			const count = (s: string, c: string) =>
				(s.match(new RegExp(`class="[^"]*\\b${c}\\b`, "g")) ?? []).length;
			expect(count(windowWeather("clear", false), "ps-yt-cloud")).to.be.at.least(2);
			expect(count(windowWeather("rain", false), "ps-yt-rain")).to.be.greaterThan(
				count(windowWeather("rain", true), "ps-yt-rain")
			);
			expect(count(windowWeather("snow", false), "ps-yt-drift")).to.equal(3);
			expect(count(windowWeather("storm", false), "ps-yt-rain")).to.be.greaterThan(
				count(windowWeather("rain", false), "ps-yt-rain")
			);
			expect(windowWeather("heat", false)).to.not.contain("ps-yt-deck");
		});

		it("marks the still windows' fair clouds and their weather in flight, and nothing else", function () {
			const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
			expect(windowWeather("clear", false)).to.match(
				/class="ps-yt-cloud ps-yt-still-clouds"/
			);
			const rain = windowWeather("rain", false);
			expect(count(rain, /ps-yt-still-clouds/g), "the deck's clouds stay").to.equal(0);
			expect(count(rain, /class="ps-yt-rain ps-yt-still-weather"/g)).to.equal(
				count(rain, /class="ps-yt-rain/g)
			);
			expect(rain).to.not.match(/ps-yt-drop[^"]*ps-yt-still/);
			const snow = windowWeather("snow", false);
			expect(count(snow, /class="ps-yt-flake ps-yt-still-weather"/g)).to.equal(
				count(snow, /class="ps-yt-flake/g)
			);
			expect(snow).to.not.match(/ps-yt-drift[^"]*ps-yt-still/);
		});

		it("clips only to windows the room defines", function () {
			for (const ref of windowWeather("storm", false).matchAll(/url\(#([^)]+)\)/g)) {
				expect(WINDOW_CLIPS as readonly string[]).to.include(ref[1]);
			}
		});
	});

	describe("the windows' motion (plan 2, §8)", function () {
		const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
		const panesOf = (s: string) => s.split('<div class="ps-ym-pane" ').slice(1);
		const windowsOf = (s: string) => s.split('<g clip-path="url(#ps-yt-win-').slice(1);
		// rain.ts draws each sheet's drops twice, one tile under the other.
		const drops = (pane: string) => count(pane, /<i style="left:/g) / 2;
		const clips = new Set(
			[...markup.matchAll(/<clipPath id="(ps-yt-win-[a-z]+)"/g)].map((m) => m[1])
		);

		for (const w of WEATHERS) {
			it(`${w}: one pane per window and the crown, placed and clipped, the same on every call`, function () {
				const s = windowMotion(w, false);
				expect(windowMotion(w, false)).to.equal(s);
				expect(s).to.not.match(/<(animate|set)\b/);
				const panes = panesOf(s);
				expect(panes).to.have.length(clips.size + 1);
				panes.forEach((p, i) => {
					expect(p).to.match(/^data-pane="(back|left|right|crown)"/);

					for (const v of ["--x", "--y", "--w", "--h"]) {
						expect(p, `${i} ${v}`).to.match(new RegExp(`${v}:-?[0-9.]+;`));
					}

					const poly = (/clip-path:polygon\(([^)]*)\)/.exec(p) ?? ["", ""])[1].split(",");

					if (i < panes.length - 1) {
						expect(poly, `pane ${i}`).to.have.length(4);
					} else {
						expect(poly.length, "the crown").to.be.at.least(20);
					}
				});
				expect(panes.at(-1)).to.match(/^data-pane="crown"/);
			});
		}

		it("drifts the fair weathers' clouds, as many as the still ones, faster in the wind", function () {
			const cds = (s: string) => [...s.matchAll(/--cd:([0-9.]+)s/g)].map((m) => Number(m[1]));

			for (const w of ["clear", "wind", "heat"] as const) {
				expect(count(windowMotion(w, false), /class="ps-ym-cloud"/g), w).to.equal(
					count(windowWeather(w, false), /ps-yt-still-clouds/g)
				);
			}

			expect(Math.max(...cds(windowMotion("wind", false)))).to.be.at.most(
				0.5 * Math.max(...cds(windowMotion("clear", false))) + 1
			);

			for (const w of ["rain", "snow", "storm"] as const) {
				expect(windowMotion(w, false), w).to.not.contain("ps-ym-cloud");
			}
		});

		it("rains, storms and snows in the panes as the still windows do, lightning in a storm", function () {
			const rain = windowMotion("rain", false);
			const storm = windowMotion("storm", false);
			const snow = windowMotion("snow", false);
			expect(rain).to.contain("psng-rain-tile");
			const still = windowsOf(windowWeather("rain", false));
			panesOf(rain)
				.slice(0, -1)
				.forEach((p, i) =>
					expect(drops(p), `pane ${i}`).to.equal(count(still[i], /class="ps-yt-rain/g))
				);
			expect(count(storm, /<i style="left:/g)).to.be.greaterThan(
				count(rain, /<i style="left:/g)
			);
			expect(count(storm, /class="ps-flash"/g)).to.equal(clips.size);
			expect(count(snow, /<i style="left:/g)).to.equal(
				count(windowWeather("snow", false), /class="ps-yt-flake/g)
			);
			const clear = windowMotion("clear", false);
			expect(clear).to.not.contain("psng-rain-tile");
			expect(clear).to.not.contain("ps-snow");
			expect(clear).to.not.contain("ps-flash");
		});

		it("twinkles stars in every pane: six in the back window, four in a side one, five in the crown", function () {
			const panes = panesOf(windowMotion("clear", false));
			panes.forEach((p) => {
				const want = p.startsWith('data-pane="back"')
					? 6
					: p.startsWith('data-pane="crown"')
					? 5
					: 4;
				expect(count(p, /class="ps-ym-tw"/g), p.slice(0, 20)).to.equal(want);
			});
		});

		it("halves the drops and the flakes on a phone (Review Focus 4)", function () {
			for (const w of ["rain", "storm", "snow"] as const) {
				const full = panesOf(windowMotion(w, false));
				const half = panesOf(windowMotion(w, true));
				const of = (p: string) => (w === "snow" ? count(p, /<i style="left:/g) : drops(p));
				full.slice(0, -1).forEach((p, i) =>
					expect(Math.abs(of(half[i]) - of(p) / 2), `${w} pane ${i}`).to.be.at.most(1)
				);
			}
		});
	});
});
