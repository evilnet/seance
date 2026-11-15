import {expect} from "chai";
import {WEATHERS} from "../../../client/js/scenes/ps/engine";
import {
	ROOM_PIECES,
	roomMarkup,
	WINDOW_CLIPS,
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
			'<div class="ps-ym-top"></div></div>',
		].map(at);
		expect(order[0]).to.equal(0);
		order.slice(1).forEach((i, k) => expect(i, `layer ${k + 1}`).to.be.above(order[k]));
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

		it("clips only to windows the room defines", function () {
			for (const ref of windowWeather("storm", false).matchAll(/url\(#([^)]+)\)/g)) {
				expect(WINDOW_CLIPS as readonly string[]).to.include(ref[1]);
			}
		});
	});
});
