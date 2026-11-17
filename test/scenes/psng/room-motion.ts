import {expect} from "chai";
import {readFileSync} from "node:fs";
import {ROOM_MOTION_CSS} from "../../../client/js/scenes/psng/room-motion";
import {NG_STILL_CSS} from "../../../client/js/scenes/psng/styles";
import {DESIGN_FRAME} from "../../../client/js/scenes/ps/yurt";

// The yurt's motion stylesheet (psng/room-motion.ts, docs/projects/ps-yurt.md §8) on its text: inside
// the room only, each group out of the page without its class and in phase with it, its still drawing
// out while it moves, and only keyframes that move by transform and opacity.

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const KEYFRAMES = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;
/** The sheet's rules as [selector, body], comments and @keyframes blocks out. */
const rules = [
	...strip(ROOM_MOTION_CSS)
		.replace(KEYFRAMES, "")
		.matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => [m[1].trim(), m[2]] as const);
const defined = (css: string) =>
	new Set([...strip(css).matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
const PS_CSS = readFileSync("client/themes/ps.css", "utf8");

/** Whether some rule, under `scope`, names `.cls` and has a body matching `body`. */
const rule = (scope: string, cls: string, body: RegExp) =>
	rules.some(
		([sel, b]) =>
			sel.split(",").some((s) => s.includes(scope) && s.includes(`.${cls}`)) && body.test(b)
	);
const NONE = /display:\s*none/;
const PHASED = /animation-delay:[^;]*var\(--psng-t\)/;

describe("the yurt's motion stylesheet (psng/room-motion.ts)", function () {
	it("selects inside the room only, never the plains", function () {
		for (const [sel] of rules) {
			for (const one of sel.split(",").map((s) => s.trim())) {
				expect(one).to.match(/^#theme-scene/);
				expect(one).to.match(/\.ps-indoor|\.ps-ym-|\.ps-yt-still-/);
			}
		}
	});

	it("clouds: out of the page without psng-m-clouds, in phase with it, the still clouds out while they move", function () {
		expect(rule(":not(.psng-m-clouds)", "ps-ym-cloud", NONE), "hidden").to.equal(true);
		expect(rule(".psng-m-clouds ", "ps-ym-cloud", PHASED), "in phase").to.equal(true);
		expect(rule(".psng-m-clouds ", "ps-yt-still-clouds", NONE), "swapped").to.equal(true);
	});

	it("rests a window cloud on its path where its loop puts it, whatever the group (the red team's C1)", function () {
		expect(
			rules.some(
				([sel, b]) =>
					sel === "#theme-scene .ps-ym-cloud" &&
					/transform:\s*translateX\(calc\(\(100cqw \+ 100% \+ 0\.5rem\) \* var\(--cp\) - 100% - 0\.25rem\)\)/.test(
						b
					)
			)
		).to.equal(true);
	});

	it("places the boxes by the design frame's own scale and middle (yurt.ts DESIGN_FRAME; the red team's D2)", function () {
		const f = DESIGN_FRAME;
		const css = strip(ROOM_MOTION_CSS);
		expect(css)
			.to.contain(`calc(100cqw / ${f.width})`)
			.and.contain(`calc(100cqh / ${f.height})`);
		expect(css).to.contain(`(var(--x) - ${f.x + f.width / 2})`);
		expect(css).to.contain(`(var(--y) - ${f.y + f.height / 2})`);
	});

	it("calm: the window clouds leave calm before the fire does, their still drawing shown (spec §11; plan 2, task 6)", function () {
		expect(rule(".psng-calm ", "ps-ym-cloud", NONE), "the moving clouds out").to.equal(true);
		expect(
			rule(".psng-calm ", "ps-yt-still-clouds", /display:\s*inline/),
			"the still ones back"
		).to.equal(true);
		const at = (cls: string, body: RegExp) =>
			rules.findIndex(([sel, b]) => sel.includes(cls) && body.test(b));
		expect(at(".psng-calm .ps-yt-still-clouds", /inline/), "after the swap").to.be.above(
			at(".psng-m-clouds .ps-yt-still-clouds", NONE)
		);
	});

	it("stars: out of the page without psng-m-stars, each twinkle in phase with it", function () {
		expect(rule(":not(.psng-m-stars)", "ps-ym-stars", NONE), "hidden").to.equal(true);
		expect(rule(".psng-m-stars ", "ps-ym-tw", PHASED), "in phase").to.equal(true);
	});

	it("weather: the still streaks and flakes out while the weather moves (the moving weather is NG's own rules)", function () {
		expect(rule(".psng-m-weather ", "ps-yt-still-weather", NONE)).to.equal(true);
	});

	it("hearth: the stove's glow and the lamp's flame flicker with psng-m-hearth, in phase; the fire and the lamp out of the page without it; the still fire out while they move", function () {
		expect(rule(":not(.psng-m-hearth)", "ps-ym-fire", NONE), "the fire hidden").to.equal(true);
		expect(rule(":not(.psng-m-hearth)", "ps-ym-lamp", NONE), "the lamp hidden").to.equal(true);

		for (const c of ["ps-ym-fireglow", "ps-ym-flame"]) {
			expect(rule(".psng-m-hearth ", c, PHASED), c).to.equal(true);
		}

		expect(rule(".psng-m-hearth ", "ps-yt-still-hearth", NONE), "swapped").to.equal(true);
	});

	it("hearth: the tongues and the core dance in phase with psng-m-hearth, at full only (§16)", function () {
		const beats: Array<[string, RegExp]> = [
			["ps-ym-t1", /animation:\s*psng-yt-lick-a 0\.95s ease-in-out infinite/],
			["ps-ym-t2", /animation:\s*psng-yt-lick-b 1\.2s ease-in-out infinite/],
			["ps-ym-t3", /animation:\s*psng-yt-lick-c 0\.8s ease-in-out infinite/],
			["ps-ym-core", /animation:\s*psng-yt-core 0\.45s ease-in-out infinite alternate/],
		];
		const FULL = ".psng-m-hearth:not(.psng-calm) ";

		for (const [c, beat] of beats) {
			expect(rule(FULL, c, PHASED), `${c} in phase`).to.equal(true);
			expect(rule(FULL, c, beat), `${c} on its beat`).to.equal(true);
			// No dance outside full: every rule that licks or breathes is scoped away from calm.
			expect(
				rules.some(
					([sel, b]) =>
						/psng-yt-(lick-[abc]|core)\b/.test(b) &&
						sel
							.split(",")
							.some((x) => x.includes(`.${c}`) && !x.includes(":not(.psng-calm)"))
				),
				`${c} dances in calm`
			).to.equal(false);
		}
	});

	it("calm: the tongues and the core flicker by opacity instead, each on its own beat (the user, 2026-11-16)", function () {
		const CALM = ".psng-m-hearth.psng-calm ";
		const beats = new Set<string>();

		for (const c of ["ps-ym-t1", "ps-ym-t2", "ps-ym-t3", "ps-ym-core"]) {
			expect(rule(CALM, c, PHASED), `${c} in phase`).to.equal(true);
			const body = rules.find(
				([sel, b]) =>
					sel.includes(CALM.trim()) && sel.includes(`.${c}`) && /animation:/.test(b)
			)?.[1];
			const m = /animation:\s*(psng-yt-flick(?:-b)?) ([0-9.]+s)/.exec(body ?? "");
			expect(m, `${c} flickers`).to.not.equal(null);
			beats.add(`${m?.[2]} ${/animation-delay:\s*([^;]+)/.exec(body ?? "")?.[1]}`);
		}

		expect(beats.size, "four beats, not one pulse").to.equal(4);
	});

	it("the sparks rise at full and rest in calm (§16)", function () {
		expect(
			rule(".psng-m-hearth:not(.psng-calm) ", "ps-ym-spark", PHASED),
			"in phase at full"
		).to.equal(true);
		expect(
			rule(
				".psng-m-hearth:not(.psng-calm) ",
				"ps-ym-spark",
				/animation:\s*psng-yt-rise var\(--sd\) linear infinite/
			),
			"on their own beats"
		).to.equal(true);
		expect(rule("", "ps-ym-spark", /opacity:\s*0\.001/), "resting").to.equal(true);
		expect(rule(".psng-calm ", "ps-ym-spark", NONE), "out in calm").to.equal(true);
	});

	it("the fire's strength and size follow the burn (§16)", function () {
		expect(rule("", "ps-ym-fire", /opacity:\s*var\(--ps-in-burn\)/), "strength").to.equal(true);
		expect(rule("", "ps-ym-fire", /overflow:\s*hidden/), "kept in the door").to.equal(true);
		expect(rule("", "ps-ym-flames", /transform:[^;]*var\(--ps-in-burn\)/), "size").to.equal(
			true
		);
		expect(rule("", "ps-ym-flames", /transform-origin:\s*50% 100%/), "from the coals").to.equal(
			true
		);
	});

	it("steam: out of the page without psng-m-steam, rising in phase with it; the still steam out while it moves", function () {
		expect(rule(":not(.psng-m-steam)", "ps-ym-steam", NONE), "hidden").to.equal(true);
		expect(rule(".psng-m-steam ", "ps-ym-steam", PHASED), "in phase").to.equal(true);
		expect(rule(".psng-m-steam ", "ps-yt-still-steam", NONE), "swapped").to.equal(true);
	});

	it("the mockup's two flickers move by opacity alone, never at exactly 1 or 0", function () {
		for (const name of ["psng-yt-flick", "psng-yt-flick-b"]) {
			const block = new RegExp(
				`@keyframes ${name}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*[^{}]*)\\}`
			).exec(strip(ROOM_MOTION_CSS));
			expect(block, name).to.not.equal(null);
			const values = [...(block?.[1] ?? "").matchAll(/opacity:\s*([0-9.]+)/g)].map((m) =>
				Number(m[1])
			);
			expect(values.length, name).to.be.greaterThan(3);
			values.forEach((v) => expect(v, name).to.be.above(0).and.below(1));
			expect(block?.[1], name).to.not.match(/transform/);
		}
	});

	it("the licks move by transform alone; the core and the sparks fade, never at exactly 1 or 0 (§16)", function () {
		const block = (name: string) =>
			(new RegExp(`@keyframes ${name}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*[^{}]*)\\}`).exec(
				strip(ROOM_MOTION_CSS)
			) ?? ["", ""])[1];

		for (const name of ["psng-yt-lick-a", "psng-yt-lick-b", "psng-yt-lick-c"]) {
			expect(block(name), name).to.match(/transform/);
			expect(block(name), name).to.not.match(/opacity/);
		}

		for (const name of ["psng-yt-core", "psng-yt-rise"]) {
			const values = [...block(name).matchAll(/opacity:\s*([0-9.]+)/g)].map((m) =>
				Number(m[1])
			);
			expect(values.length, name).to.be.at.least(2);
			values.forEach((v) => expect(v, name).to.be.above(0).and.below(1));
			expect(block(name), name).to.match(/transform/);
		}
	});

	it("names only keyframes that exist, and defines only ones that move by transform and opacity", function () {
		const known = new Set([
			...defined(PS_CSS),
			...defined(NG_STILL_CSS),
			...defined(ROOM_MOTION_CSS),
		]);

		for (const m of strip(ROOM_MOTION_CSS).matchAll(/animation:\s*([\w-]+)/g)) {
			expect(known.has(m[1]), m[1]).to.equal(true);
		}

		for (const m of strip(ROOM_MOTION_CSS).matchAll(KEYFRAMES)) {
			for (const p of m[2].matchAll(/([\w-]+)\s*:/g)) {
				expect(["transform", "opacity"], `${m[1]}: ${p[1]}`).to.include(p[1]);
			}
		}
	});

	it("is exempt from NG's catch-all still: every class it animates is in that rule's :not() list", function () {
		const list = (/#theme-scene\.psng \*:not\(([^)]*)\)/.exec(NG_STILL_CSS) ?? ["", ""])[1]
			.split(",")
			.map((x) => x.trim());
		const animated = rules
			.filter(([, body]) => /animation:/.test(body))
			.flatMap(([sel]) =>
				sel
					.split(",")
					.map((x) =>
						x
							.trim()
							.replace(
								/^#theme-scene\.psng\.psng-m-[a-z]+(:not\([^)]*\)|\.psng-calm)? /,
								""
							)
					)
			);
		expect(animated).to.not.be.empty;

		// A compound like .ps-ym-tongue.ps-ym-t1 is exempt through any one of its classes.
		const exempt = (a: string) =>
			list.includes(a) ||
			(/^(\.[\w-]+)+$/.test(a) &&
				a
					.split(".")
					.filter(Boolean)
					.some((c) => list.includes(`.${c}`)));

		for (const a of animated) {
			expect(exempt(a), a).to.equal(true);
		}
	});

	it("no transition, no media query, no glass", function () {
		const css = strip(ROOM_MOTION_CSS);
		expect(css).to.not.match(/transition/);
		expect(css).to.not.match(/@media/);
		expect(css).to.not.match(/backdrop-filter/);
	});
});
