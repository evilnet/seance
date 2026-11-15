import {expect} from "chai";
import {readFileSync} from "node:fs";
import {ROOM_MOTION_CSS} from "../../../client/js/scenes/psng/room-motion";
import {NG_STILL_CSS} from "../../../client/js/scenes/psng/styles";

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

	it("stars: out of the page without psng-m-stars, each twinkle in phase with it", function () {
		expect(rule(":not(.psng-m-stars)", "ps-ym-stars", NONE), "hidden").to.equal(true);
		expect(rule(".psng-m-stars ", "ps-ym-tw", PHASED), "in phase").to.equal(true);
	});

	it("weather: the still streaks and flakes out while the weather moves (the moving weather is NG's own rules)", function () {
		expect(rule(".psng-m-weather ", "ps-yt-still-weather", NONE)).to.equal(true);
	});

	it("hearth: the fire, its glow and the lamp's flame flicker with psng-m-hearth, in phase; out of the page without it; the still fire out while they move", function () {
		expect(rule(":not(.psng-m-hearth)", "ps-ym-fire", NONE), "the fire hidden").to.equal(true);
		expect(rule(":not(.psng-m-hearth)", "ps-ym-lamp", NONE), "the lamp hidden").to.equal(true);

		for (const c of [
			"ps-ym-fire-body",
			"ps-ym-fireglow",
			"ps-ym-fire-tongues",
			"ps-ym-flame",
		]) {
			expect(rule(".psng-m-hearth ", c, PHASED), c).to.equal(true);
		}

		expect(rule(".psng-m-hearth ", "ps-yt-still-hearth", NONE), "swapped").to.equal(true);
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
					.map((x) => x.trim().replace(/^#theme-scene\.psng\.psng-m-[a-z]+ /, ""))
			);
		expect(animated).to.not.be.empty;

		for (const a of animated) {
			expect(list, a).to.include(a);
		}
	});

	it("no transition, no media query, no glass", function () {
		const css = strip(ROOM_MOTION_CSS);
		expect(css).to.not.match(/transition/);
		expect(css).to.not.match(/@media/);
		expect(css).to.not.match(/backdrop-filter/);
	});
});
