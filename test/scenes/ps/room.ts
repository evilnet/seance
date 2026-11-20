import {expect} from "chai";
import {WEATHERS} from "../../../client/js/scenes/ps/engine";
import {roomCss} from "../../../client/js/scenes/ps/indoor";
import {DESIGN_FRAME, project, ROOM_GEOMETRY} from "../../../client/js/scenes/ps/yurt";
import {
	CURTAIN_ROD,
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
		expect(markup.indexOf('class="ps-yt-weather"')).to.be.within(0, panes);
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
		expect(markup.indexOf('class="ps-yt-still-hearth ps-yt-burn"')).to.be.above(over);
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
		expect(still, "the still fire: one frame of the moving one").to.contain("<feGaussianBlur");
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
		expect(markup.split("ps-yt-still-steam").length - 1, "the still steam, once").to.equal(1);
	});

	it("draws the still steam once, over the stove's second drawing, not under it as well (the red team's D3)", function () {
		const over = markup.slice(
			markup.indexOf('<svg class="ps-yt ps-yt-over"'),
			markup.indexOf('<div class="ps-ym-top">')
		);
		expect(over).to.contain("ps-yt-still-steam");
		expect(markup.slice(0, markup.indexOf('<svg class="ps-yt ps-yt-over"'))).to.not.contain(
			"ps-yt-still-steam"
		);
	});

	it("carries every element the scene writes into or gates (scene.ts; the red team's S2)", function () {
		for (const cls of [
			"ps-indoor",
			"ps-yt-weather",
			"ps-ym-panes",
			"ps-ym-fire",
			"ps-ym-fireglow",
			"ps-ym-steam",
		]) {
			expect(markup, cls).to.match(new RegExp(`class="(?:[^"]* )?${cls}(?: [^"]*)?"`));
		}
	});

	it("carries every class its stylesheet fades by the hour (indoor.ts roomCss; the red team's S4)", function () {
		const faded = [
			...roomCss().matchAll(/((?:\.ps-yt-[a-z-]+,?\s*)+)\{ opacity: var\(/g),
		].flatMap((m) => m[1].split(",").map((x) => x.trim().slice(1)));
		expect(faded).to.include.members(["ps-yt-moon", "ps-yt-star", "ps-yt-golden"]);

		for (const cls of faded) {
			expect(markup, cls).to.match(new RegExp(`class="(?:[^"]* )?${cls}(?: [^"]*)?"`));
		}
	});

	it("frames every layer in the design frame (yurt.ts DESIGN_FRAME; the red team's D2)", function () {
		const f = DESIGN_FRAME;
		const boxes = [...markup.matchAll(/<svg class="ps-yt[^"]*" viewBox="([^"]+)"/g)].map(
			(m) => m[1]
		);
		expect(boxes.length).to.be.at.least(4);
		boxes.forEach((b) => expect(b).to.equal(`${f.x} ${f.y} ${f.width} ${f.height}`));
	});

	it("draws each crown post's pole after its base and its cap: above the eye, the pole covers the cap's underside (the user, 2026-11-19)", function () {
		const starts = [...markup.matchAll(/<g class="ps-yt-p-post">/g)].map((m) => m.index ?? 0);
		expect(starts.length, "two posts").to.equal(2);

		for (const at of starts) {
			const next = markup.indexOf('class="ps-yt-p-', at + 20);
			const post = markup.slice(at, next < 0 ? undefined : next);
			expect(post.lastIndexOf("ps-yt-c-furnD"), "the cap before the pole").to.be.below(
				post.indexOf("ps-yt-c-pole")
			);
		}
	});

	it("hangs the back curtains' rod on the wall: under the lattice's top, across the curtains' heads, ending just past them on finials and brackets (the user, 2026-11-19)", function () {
		// The curtains' heads are at 2.0 m, their outer edges at ±1.87 m (curtainOutline).
		const {height, end, depth} = CURTAIN_ROD;
		const R = ROOM_GEOMETRY.radius;
		expect(end, "just past the curtains").to.be.above(1.87).and.below(2.0);
		expect(depth, "in front of the wall at its ends").to.be.below(Math.sqrt(R * R - end * end));

		for (const x of [-end, 0, end]) {
			const rodY = project([x, height, depth])[1];
			const latticeTop = project([x, ROOM_GEOMETRY.wallHeight, Math.sqrt(R * R - x * x)])[1];
			expect(rodY, `under the lattice's top on screen at x ${x}`).to.be.above(
				latticeTop + 0.5
			);
		}

		const curtainsAt = markup.indexOf('<g class="ps-yt-p-curtains">');
		const rodAt = markup.indexOf('<g class="ps-yt-rod">');
		expect(rodAt, "in front of the curtains, drawn after them").to.be.above(
			markup.lastIndexOf(
				"ps-yt-c-curtain",
				markup.indexOf('class="ps-yt-p-', curtainsAt + 20)
			)
		);
		expect(markup.split('class="ps-yt-rod"').length - 1).to.equal(1);
		const rod = markup.slice(rodAt, markup.indexOf('class="ps-yt-p-', rodAt));
		expect(rod.split("ps-yt-c-gold").length - 1, "a finial at each end").to.equal(2);
		const windowBack = markup.slice(
			markup.indexOf('<g class="ps-yt-p-window-back">'),
			curtainsAt
		);
		expect(windowBack, "no rod left floating with the window").to.not.contain(
			'stroke-linecap="round"'
		);
	});

	describe("the bed (the user, 2026-11-20: a visual pass on its proportions)", function () {
		const at = markup.indexOf('<g class="ps-yt-p-bed">');
		const bed = markup.slice(at, markup.indexOf('class="ps-yt-p-', at + 20));
		const points = (poly: string) =>
			poly.split(" ").map((p) => p.split(",").map(Number) as [number, number]);

		it("stands on its four corner posts, with no leg beside a post", function () {
			const posts = [...bed.matchAll(/<g class="ps-yt-bedpost">(.*?)<\/g>/g)].map(
				(m) => m[1]
			);
			expect(posts.length, "four posts").to.equal(4);
			const inPosts = posts.join("").split("ps-yt-c-furnD").length - 1;
			expect(
				bed.split("ps-yt-c-furnD").length - 1,
				"every dark-wood face is a post's"
			).to.equal(inPosts);
		});

		it("turns the quilt's sheet down its side to the hem, not a block at its top", function () {
			const cuff = points(
				(/<polygon points="([^"]+)" class="ps-yt-c-sheetSide"/.exec(bed) ?? ["", ""])[1]
			);
			const drape = [...bed.matchAll(/<polygon points="([^"]+)" class="ps-yt-c-blue"/g)]
				.map((m) => points(m[1]))
				.find((l) => l.length > 40);
			expect(drape, "the quilt's drape").to.not.equal(undefined);
			const right = Math.max(...cuff.map(([x]) => x));
			const hem = Math.max(
				...(drape ?? []).filter(([x]) => x <= right + 1).map(([, y]) => y)
			);
			expect(Math.max(...cuff.map(([, y]) => y)), "down to the hem").to.be.closeTo(hem, 1.5);
		});
	});

	it("draws the stove's fire soft and flowing: three blurred layers of six poses, a white-hot core, the embers and the firebox's glow, clipped to the door (the user, 2026-11-21)", function () {
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
		const at = (c: string) => flames.indexOf(c);
		expect(at('class="ps-ym-fback"'), "the firebox's glow, first").to.be.above(0);
		expect(at('class="ps-ym-fembers"')).to.be.above(at('class="ps-ym-fback"'));
		// Outer, then the white-hot core, then mid and inner, which add their light to it.
		expect(at('class="ps-ym-fl ps-ym-fl-outer"')).to.be.above(at('class="ps-ym-fembers"'));
		expect(at('class="ps-ym-hotcore"')).to.be.above(at('class="ps-ym-fl ps-ym-fl-outer"'));
		expect(at('class="ps-ym-fl ps-ym-fl-mid"')).to.be.above(at('class="ps-ym-hotcore"'));
		expect(at('class="ps-ym-fl ps-ym-fl-inner"')).to.be.above(
			at('class="ps-ym-fl ps-ym-fl-mid"')
		);

		for (const layer of ["outer", "mid", "inner"]) {
			const from = at(`class="ps-ym-fl ps-ym-fl-${layer}"`);
			const body = flames.slice(from, flames.indexOf('class="ps-ym-fl ', from + 10));
			const keys = [...body.matchAll(/<div class="ps-ym-fpose" style="--fk:(\d)">/g)].map(
				(m) => Number(m[1])
			);
			expect(keys, `${layer}: six poses in order`).to.deep.equal([0, 1, 2, 3, 4, 5]);
			expect(body.split("<feGaussianBlur").length - 1, `${layer}: each blurred`).to.equal(6);
		}

		for (const gone of ["ps-ym-tongue", "ps-ym-core", "ps-ym-spark", 'ps-yt-fire"']) {
			expect(markup, gone).to.not.contain(gone);
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
		// Both are room colours, shaded with the hour and seen by the legibility sweep (§9): by day
		// the dark door stands under the message column (the final review of plan 3).
		const firebox = bed.indexOf('class="ps-yt-c-firebox"');
		expect(firebox, "a dark firebox behind the coals (§16)").to.be.above(0);
		expect(firebox).to.be.below(bed.indexOf('class="ps-yt-c-coalBed"'));
		expect(bed).to.not.contain('fill="#3a1610"');
		// Under the night glass it darkens behind the flames (never shaded: the sweep checks it, indoor.ts).
		const dark = bed.indexOf('fill="#120d10" class="ps-yt-lit ps-yt-cavity"');
		expect(dark, "the firebox darkening with the burn").to.be.above(firebox);
		expect(dark).to.be.below(bed.indexOf('class="ps-yt-c-coalBed"'));
		expect(embers).to.be.below(over.indexOf('class="ps-yt-still-hearth ps-yt-burn"'));
		expect(
			markup.split("ps-yt-still-steam ps-yt-burn").length - 1,
			"the still steam, once"
		).to.equal(1);
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

	it("gives every window cloud its place in its loop (--cp), so a cloud at rest stands on its path (the red team's C1)", function () {
		for (const w of ["clear", "wind", "heat"] as const) {
			const clouds = [
				...windowMotion(w, false).matchAll(/class="ps-ym-cloud" style="([^"]+)"/g),
			].map((m) => m[1]);
			expect(clouds.length, w).to.be.above(0);

			for (const st of clouds) {
				const num = (k: string) =>
					Number((new RegExp(`--${k}:(-?[0-9.]+)`).exec(st) ?? ["", "NaN"])[1]);
				expect(num("cp"), `${w}: ${st}`).to.be.closeTo(-num("cdl") / num("cd"), 1e-3);
				expect(num("cp")).to.be.within(0, 1);
			}
		}
	});
});
